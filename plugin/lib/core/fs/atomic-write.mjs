/**
 * 全仓**唯一写盘原语出口**（CHG-174，移植自 `dsh-task-ledger` 的 `store.WriteTextAtomic`）。
 *
 * ── 为什么移植这一段 ────────────────────────────────────────────────────────────
 * 本项目原有的「原子写」是 `writeFileSync(tmp) + renameSync(tmp, path)` —— 只有两步，
 * 少了四样东西，每一样都是真实故障面：
 *
 *   ① **没有 `fsync(file)`**：`rename` 只是改目录项，页缓存没落盘时掉电会得到
 *      「文件名在、内容是空洞」的文件。长度对、内容全 `\0`，比丢文件更难查。
 *   ② **没有 `fsync(dir)`**：`rename` 产生的目录项本身也可能丢，掉电后新旧名字都不在。
 *   ③ **临时文件名固定成 `${path}.tmp`**：两个写者并发时互相覆盖，`rename` 出来的
 *      是两份内容交织的半截 JSON —— 这是**并发写坏文件**，不是「最后写入者胜」。
 *   ④ **不拒符号链接**：`ln -s ~/.ssh/id_rsa team.json` 之后，一次「原子写」会把
 *      目标替换成普通文件，等于**写穿到任意路径**。
 *
 * ── 写序（顺序本身就是协议，不要调换）──────────────────────────────────────────
 *   父目录存在性 → 拒符号链接 → 捕获原权限 → 同目录唯一临时文件
 *   → 写入 → fsync(file) → chmod → rename → fsync(dir)
 *
 * `fsync(file)` 必须在 `rename` 之前、`fsync(dir)` 必须在之后。反了会拿到空 inode。
 *
 * ── 失败语义 ──────────────────────────────────────────────────────────────────
 * 任何一步失败都清理临时文件，**目标文件保持原样**。这就是「整份替换」的全部价值：
 * 不存在「写坏一半」的中间态，重跑一次即可。
 *
 * ── 记账本 ────────────────────────────────────────────────────────────────────
 * 本文件只提供**原语**，不感知记账本。要「记这一轮改了哪些文件」请走
 * `./write-log.ts` 的 `writeTextAtomic`（它包一层 `WriteLog.record`）。
 * 依赖方向单向：`write-log.ts` → `atomic-write.ts`，反过来不成立。
 */
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
                                          

/** 文件系统层错误：带 `MT_*` 码，调用方按码分支而不是匹配中文。 */
export class FsError extends Error {
           code        

  constructor(code        , message        ) {
    super(message)
    this.name = 'FsError'
    this.code = code
  }
}

/**
 * 建目录（`mkdir -p` 语义）。**全仓唯一建目录的地方**。
 *
 * 为什么单独一个函数：`writeTextAtomic` **刻意不替人建父目录** —— 自动建目录会让
 * 「路径写错了」变成「在错的地方建出一个新的空目录」，而正确行为是当场报错。
 * 需要建目录的调用点显式调本函数，意图可审计。
 */
export function ensureDir(path        )       {
  try {
    mkdirSync(path, { recursive: true })
  } catch (error) {
    throw new FsError('MT_FS_WRITE_FAILED', `建目录 ${path} 失败：${messageOf(error)}`)
  }
}

function messageOf(error         )         {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 刷父目录。**掉电时 rename 的目录项可能丢，只刷文件是不够的。**
 *
 * 刻意吞错：Windows 上对目录句柄 `FlushFileBuffers` 必然返回错误（目录不是文件），
 * 因此「报错」在这里是常态而非异常。POSIX 上的 `EIO` / `ENOSPC` 也会被一起吞掉 ——
 * 这是已知取舍：真报出来会让 Windows 上 100% 的写盘都失败，而漏报只影响掉电一致性。
 */
export function fsyncDir(dir        )       {
  let fd                    
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch {
    // 见上：Windows 目录 fsync 必失败；POSIX 真错误也无法回滚已完成的 rename
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // 关闭失败不影响脏页已经进目录项
      }
    }
  }
}

/** 唯一临时文件名：同目录 + 进程号 + 随机串，保证并发写者互不覆盖。 */
function tempPathFor(path        )         {
  return join(dirname(path), `${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
}

/** 写盘原语的公共选项。 */
                                         
     
                   
    
                                             
                                                   
     
                        
 

/**
 * CHG-210：`rename` 的 Windows 句柄占用兜底。
 *
 * 现场：Windows 上编辑器打开着目标文件、杀软正在扫、或索引器正在读时，`rename` 会被打回
 * `EPERM` / `EACCES` / `EBUSY`。旧实现直接失败——而本项目就跑在 Windows 上，这是真实的
 * 可用性风险（不是理论问题：参考项目 `dsh-agent-teams` 专门为它写了重试 + 降级）。
 *
 * 处置分两级：
 *   ① 重试 3 次（同步忙等 50ms，总计 ≤150ms）——绝大多数占用是瞬时扫描；
 *   ② 仍失败则**就地直写**：内容已经完整写在临时文件里，等价降级只放弃「无半截」保证。
 *
 * ⚠ 降级只对**可重建文件**成立（配置 / 侧车 / 索引 / 导出快照）。账本不走这条路径
 * （它走 `appendTextSync` 的 append + fsync），所以「账本绝不能半截」没有被削弱。
 */
function renameWithRetry(tmp        , target        )       {
  try {
    renameSync(tmp, target)
    return
  } catch (error) {
    const code = (error                                     )?.code
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    busyWaitMs(50)
    try {
      renameSync(tmp, target)
      return
    } catch {
      // 继续重试；三次都失败才降级
    }
  }
  writeFileSync(target, readFileSync(tmp))
  try {
    unlinkSync(tmp)
  } catch {
    // 临时文件清不掉不影响结果（同名临时文件下次写入会覆盖）
  }
}

/** 同步忙等（调用链是同步函数，没有 await 可用；50ms 级等待对写盘路径可接受） */
function busyWaitMs(ms        )       {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // 故意空转：这里没有异步上下文
  }
}

/**
 * 原子写文本：同目录唯一临时文件 → 写入 → fsync(file) → 继承权限 → rename → fsync(dir)。
 *
 * @param path 目标文件绝对路径
 * @param text 完整新内容（**整份替换**，不是追加）
 * @param options 见 {@link WriteTextAtomicOptions}
 */
export function writeTextAtomicRaw(path        , text        , options                         = {})       {
  const parent = dirname(path)
  if (options.ensureParent === true) {
    ensureDir(parent)
  }
  let parentStat
  try {
    parentStat = statSync(parent)
  } catch {
    throw new FsError(
      'MT_FS_WRITE_FAILED',
      `写 ${path} 失败：父目录 ${parent} 不存在（建目录要显式调 ensureDir）。`,
    )
  }
  if (!parentStat.isDirectory()) {
    throw new FsError(
      'MT_FS_WRITE_FAILED',
      `写 ${path} 失败：父路径 ${parent} 不是目录（建目录要显式调 ensureDir）。`,
    )
  }

  // ① 拒符号链接：否则「整份替换」会写穿到链接目标
  let existing
  try {
    existing = lstatSync(path)
  } catch {
    existing = undefined
  }
  if (existing !== undefined && existing.isSymbolicLink()) {
    throw new FsError(
      'MT_FS_SYMLINK_REFUSED',
      `拒绝写入 ${path}：它是符号链接，写入会把它替换成普通文件（等于写穿到链接目标）。`,
    )
  }

  // ② 捕获原权限：临时文件建出来是 0600，不继承会把可写可读的配置改成仅所有者可读
  const mode = existing === undefined ? 0o644 : existing.mode & 0o777
  const tmp = tempPathFor(path)

  let fd                    
  try {
    fd = openSync(tmp, 'w')
    writeSync(fd, text, 0, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    chmodSync(tmp, mode)
    // rename 之后目标文件已是新内容；此后的失败只影响目录项持久性，不再回滚
    renameWithRetry(tmp, path)
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // 真正的失败已经确定，关闭错误没有额外信息
      }
    }
    try {
      unlinkSync(tmp)
    } catch {
      // 临时文件可能压根没建出来
    }
    if (error instanceof FsError) throw error
    throw new FsError(
      'MT_FS_WRITE_FAILED',
      `写 ${path} 失败：${messageOf(error)}\n` +
        '  处理：确认该路径可写、磁盘没满，然后重跑这条命令（文件是整份替换，不会写坏）。',
    )
  }
  fsyncDir(parent)
}

/**
 * 追加文本（**唯一追加出口**）：`open('a') → write → fsync → close`。
 *
 * 为什么不用 `writeTextAtomicRaw(path, 旧内容 + 新行)` 代替：追加式账本（JSONL）的
 * 语义就是「只增不改」，整份重写会把并发写者的行冲掉，也会让 10 万行账本每追加一行
 * 都 O(n) 重写。追加**自身**需要 `fsync` 屏障，否则崩溃时最后一行可能只写了一半。
 *
 * 调用方负责保证「一次调用 = 一整行」：半行会让重放时的尾部残行判定生效（见 ledger 的
 * `openLedger`），但那是修复路径、不是常规路径。
 */
export function appendTextSync(path        , text        , options                         = {})       {
  if (options.ensureParent === true) {
    ensureDir(dirname(path))
  }
  let fd                    
  try {
    fd = openSync(path, 'a')
    writeSync(fd, text, 0, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // 见上
      }
    }
    throw new FsError(
      'MT_FS_WRITE_FAILED',
      `追加 ${path} 失败：${messageOf(error)}\n  处理：确认该路径可写、磁盘没满。`,
    )
  }
}

/**
 * 文件内容 sha256（十六进制）。不存在返回 `''`，读不出来返回 `'unreadable'`。
 *
 * 必须是**内容哈希**而不是 `(mtime, size)`：后者在同一时间精度内连写两次会漏判
 * 「我读完以后别人动过没有」。
 */
export function fingerprint(path        )         {
  let data        
  try {
    data = readFileSync(path)
  } catch (error) {
    const code = (error                         ).code
    return code === 'ENOENT' ? '' : 'unreadable'
  }
  return createHash('sha256').update(data).digest('hex')
}

/** 写之前的原文快照。原本不存在返回 `{ before: null, had: false }`。 */
export function snapshot(path        )                                          {
  try {
    return { before: readFileSync(path, 'utf8'), had: true }
  } catch (error) {
    if ((error                         ).code === 'ENOENT') {
      return { before: null, had: false }
    }
    throw new FsError('MT_FS_WRITE_FAILED', `读 ${path} 失败（写前快照）：${messageOf(error)}`)
  }
}

/**
 * 按快照还原：`had === false` 表示原本不存在 ⇒ 删掉。
 *
 * **不进记账本**：撤销这个动作本身不该被当成「本次改动」提交。
 * 由调用方（`write-log.ts` 的 `rollbackPresync`）负责这一点。
 */
export function restore(path        , before               , had         )       {
  if (!had) {
    removeIfExists(path)
    return
  }
  writeTextAtomicRaw(path, before ?? '')
}

/** 删文件，不存在不算错。 */
export function removeIfExists(path        )       {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error                         ).code === 'ENOENT') return
    throw new FsError('MT_FS_WRITE_FAILED', `删除 ${path} 失败：${messageOf(error)}`)
  }
}


//# sourceURL=./src/core/fs/atomic-write.ts