/**
 * 规范化 JSON 与内容 hash。
 *
 * 为什么不用 `JSON.stringify` 直接算 hash：对象键顺序在 JS 里是插入顺序，
 * 同一份领域内容经过不同构造路径（迁移、面板、工具）会得到不同字节，
 * hash 也就失去「同一内容同一指纹」的意义。这里定义唯一的规范化形式：
 *
 *   - 对象键按 code unit 升序排列；
 *   - 没有空白字符；
 *   - 值为 `undefined` 的对象属性被**省略**（与 JSON.stringify 一致），
 *     但数组元素为 `undefined` 时直接报错——那会静默变成 `null`；
 *   - `NaN` / `Infinity` / `BigInt` / `Date` / `Map` / `Set` / 函数 / 符号
 *     一律报错，不做隐式转换；
 *   - 循环引用报错。
 *
 * 报错而不是「尽力序列化」是刻意的：内容 hash 是发布确认、事件去重和
 * 迁移对账的共同基准，任何静默改写都会让两套指纹看起来相同而内容不同。
 */
import { createHash } from 'node:crypto'

/** 规范化 JSON 抛出的错误，携带出错路径，便于定位是哪个字段。 */
export class CanonicalJsonError extends Error {
  readonly path: string

  constructor(message: string, path: string) {
    super(path.length > 0 ? `${message}（at ${path}）` : message)
    this.name = 'CanonicalJsonError'
    this.path = path
  }
}

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

/**
 * 把值序列化为规范 JSON 文本。
 *
 * 同一个逻辑内容无论键的插入顺序如何，输出字节完全一致。
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, '', new Set<object>())
}

function serialize(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError('数值必须是有限数，不接受 NaN/Infinity', path)
      }
      // JSON.stringify(-0) 就是 "0"，这里显式写出来，避免读代码时误判。
      return JSON.stringify(value)
    case 'undefined':
      throw new CanonicalJsonError('undefined 不能出现在这里', path)
    case 'bigint':
      throw new CanonicalJsonError('BigInt 不能进入规范 JSON，请先转成字符串', path)
    case 'function':
    case 'symbol':
      throw new CanonicalJsonError(`${typeof value} 不能进入规范 JSON`, path)
    default:
      break
  }

  const object = value as object

  if (seen.has(object)) {
    throw new CanonicalJsonError('检测到循环引用', path)
  }

  if (Array.isArray(object)) {
    seen.add(object)
    const parts: string[] = []
    for (let index = 0; index < object.length; index += 1) {
      const item: unknown = object[index]
      if (item === undefined) {
        throw new CanonicalJsonError('数组元素不能是 undefined', `${path}[${index}]`)
      }
      parts.push(serialize(item, `${path}[${index}]`, seen))
    }
    seen.delete(object)
    return `[${parts.join(',')}]`
  }

  if (object instanceof Date) {
    throw new CanonicalJsonError('Date 必须先显式转成 ISO 字符串', path)
  }
  if (object instanceof Map || object instanceof Set) {
    throw new CanonicalJsonError('Map/Set 必须先显式转成普通对象或数组', path)
  }

  const prototype = Object.getPrototypeOf(object)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalJsonError(
      `只接受普通对象，收到 ${(object as { constructor?: { name?: string } }).constructor?.name ?? '未知类型'}`,
      path,
    )
  }

  seen.add(object)
  const record = object as Record<string, unknown>
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareCodeUnits)
  const parts: string[] = []
  for (const key of keys) {
    parts.push(`${JSON.stringify(key)}:${serialize(record[key], joinPath(path, key), seen)}`)
  }
  seen.delete(object)
  return `{${parts.join(',')}}`
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function joinPath(path: string, key: string): string {
  return path.length > 0 ? `${path}.${key}` : key
}

/**
 * 内容 hash：`sha256:<hex>`。
 *
 * 前缀写进指纹本身，是为了让指纹出现在日志、审计与面板时能一眼看出算法；
 * 未来换算法（例如加盐或改规范化规则）时，新旧指纹不会因为长度相同而混淆。
 */
export function hashContent(value: unknown): string {
  const text = canonicalJson(value)
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

/** 对原始字节算 hash；用于交付物校验，不经过 JSON 规范化。 */
export function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** 深拷贝：经规范 JSON 往返，确保丢掉 undefined 与原型，得到纯数据。 */
export function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T
}
