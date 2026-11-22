# dsh-plugin-myteam 路 v2

椤圭洰绾у鏅鸿兘浣撳洟闃熻繍琛屾椂銆倂2 鏄?*閲嶅啓**锛屼笉鏄粰 v1 鎵撹ˉ涓侊細v1 鐨勫畬鏁村疄鐜颁繚瀛樺湪
Git 鏍囩 `v1-backup`锛屾湰鍒嗘敮浠庢柊鐨勫垎灞傞鏋跺紑濮嬮噸鏂板疄鐜般€?
> 鐘舵€侊細`2.0.0-alpha.1`銆俁0锝濺3锛堝绾︺€侀鍩熷唴鏍搞€佷簨浠跺簱涓庢姇褰便€侀」鐩敤渚嬶級宸茶惤鍦板苟鏈夋祴璇曪紱
> R4 瀹屾垚闃熼暱/鎴愬憳宸ュ叿闈笌瑁呴厤锛堝皻鏈畨瑁呰繘 DSH 楠岃瘉锛夛紱R5锝濺7 鏈畬鎴愩€?> **鍙畨瑁呮€?*锛歚lib/composition/host.mjs` 宸茶兘鏋勫缓骞堕€氳繃鍐掔儫锛?2 涓槦闀垮伐鍏锋敞鍐屻€佽鐪嬫澘鍙敤锛夛紝
> 浣?`panel` RPC 涓?`cordis.patch.yml` 鐨?preset 琛屽皻鏈帴涓婏紝鍥犳 R5 鍓嶄笉瑕佸畨瑁呭埌 profile銆?
## 涓轰粈涔堣閲嶅啓

v1 鐨勯棶棰樹笉鏄€屾枃浠跺お澶с€嶏紝鑰屾槸杈圭晫閿欎簡锛屼笖閿欏湪浼氳鎸佺画娌跨敤锛?
- 涓氬姟 Host 鎸傚湪 captain preset 閲岋紝鎴愬憳宸ュ叿鍙嶅悜渚濊禆鍏ュ彛 Host锛?- 閰嶇疆銆佺煡璇嗐€佹垚鍛樺崱銆佽韩浠藉揩鐓т笌绱㈠紩鍚勬湁澶氫唤鏉冨▉涓庨潪鍘熷瓙鍐欙紱
- 闈㈡澘鍦ㄧ嚎/绂荤嚎瀛樺湪澶氭潯璇诲啓璺緞锛岀绾胯鍥惧彟璧蜂竴濂楃姸鎬佹満锛?- `actor:'human'` / `confirm:true` 鍙槸鏅€氬弬鏁帮紝涓嶈兘鏋勬垚鍙俊浜虹被鎺堟潈銆?
缁х画銆屽師鍦版崲鍐呮牳銆嶄細璁╂棫 Host 缁х画鍐冲畾绯荤粺杈圭晫锛屾墍浠?v2 鍦ㄩ殧绂?worktree 涓噸寤猴紝
鏈€缁堟暣浣撴浛鎹紙瑙?[鍏ㄩ噺閲嶆瀯瀹炴柦璁捐](../docs/architecture/04-鍏ㄩ噺閲嶆瀯瀹炴柦璁捐.md)锛夈€?
## 鍒嗗眰涓庝緷璧栨柟鍚?
```text
plugin/src/
鈹溾攢鈹€ contracts/      浜嬩欢銆佹壒娆″抚銆佸疄浣撳舰鐘躲€侀敊璇爜銆佺増鏈笌瑙勮寖鍖?hash
鈹溾攢鈹€ domain/         绾鍩熻鍒欙細瀹氫箟璧勪骇銆佷换鍔?DAG銆佺姸鎬佹満銆侀厤缃悎骞躲€佹潈闄?鈹溾攢鈹€ application/    鐢ㄤ緥鍛戒护銆侀」鐩繍琛屾椂銆佸唴瀛樻姇褰憋紙绾?reducer锛?鈹溾攢鈹€ infrastructure/ 鏂囦欢浜嬩欢搴撱€佸啓鑰呯绾︼紙鏈潵锛欴SH 閫傞厤鍣ㄣ€佽縼绉昏鍙栧櫒锛?鈹斺攢鈹€ composition/    锛圧4锛塂SH 瑁呰浇涓庝緷璧栬閰?```

渚濊禆鍙兘鍚戝唴锛?
```text
composition 鈫?infrastructure 鈫?application 鈫?domain 鈫?contracts
```

鐢?`tools/check-architecture.mjs` 鏈烘妫€鏌ワ紙V1锝濾5锛氱洰褰曞綊灞炪€佷緷璧栨柟鍚戙€佸涓绘ā鍧椼€?绗笁鏂瑰寘銆佹墦鍗拌竟鐣岋級銆俙contracts/domain/application` 涓嶅緱 import `fs` /
`child_process` / `path`锛屼篃涓嶅緱 `console.log`锛涢渶瑕?IO 鎴栨棩蹇楁椂鐢?`application/ports.ts` 鐨勭鍙ｃ€?
## 宸插疄鐜扮殑涓嶅彉閲?
| 涓嶅彉閲?| 钀界偣 | 娴嬭瘯 |
|---|---|---|
| 浜嬩欢鍐呭 hash 涓庡瓧娈甸『搴忔棤鍏炽€佹嫆缁濅笉鍙棤鎹熻〃杈剧殑鍊?| `contracts/json.ts` | `t01` |
| 鎵规 = 澶村抚 + 浜嬩欢甯?+ 鎻愪氦甯э紱hash/鏁伴噺/搴忓彿涓夎€呭榻愭墠鏄?durable 鎻愪氦鐐?| `contracts/batch.ts` | `t01` |
| 鎾曡灏鹃儴涓庢崯鍧忎弗鏍煎尯鍒嗭細鍓嶈€呭彲鏄惧紡淇锛屽悗鑰呮暣涓」鐩仠鍐?| `infrastructure/event-store/log-scan.ts` | `t01`銆乣t05` |
| 杩藉姞鍓嶆牳瀵?projectSeq 杩炵画锛涜烦鍙锋嫆缁濅笖涓嶅啓鍧忔棩蹇?| `infrastructure/event-store/file-store.ts` | `t05` |
| 鍐欒€呯绾︾嫭鍗犮€乫encing 鍗曡皟銆佽繃鏈熷彲鎺ョ銆侀噴鏀剧暀澧撶 | `infrastructure/event-store/writer-lease.ts` | `t05` |
| 鑳藉姏鍙敹绐勶紱deny 涓嶈兘琚笅灞傞噸鏂版墦寮€锛沗*` 涓庣┖ allow 璇箟涓嶅悓 | `domain/definitions/role.ts` | `t02` |
| 宸ヤ綔娴佸畾涔夊彲瀹炰緥鍖栵細key 鍞竴銆佷緷璧栧瓨鍦ㄣ€佹棤鐜€佸畬鎴愭潯浠跺彲瑙ｆ瀽 | `domain/definitions/workflow.ts` | `t03` |
| 浠诲姟灏辩华鍙涓婃父 `done`锛沗cancelled` 涓嶈В闄や笅娓?| `domain/tasks/dag.ts` | `t03` |
| 瀹屾垚 = review + 闂ㄧ pass + 璇佹嵁/浜や粯鐗╅綈 + 渚濊禆瀹屾垚锛岀己涓€涓嶅彲 | `domain/tasks/task.ts` | `t04` |
| 閰嶇疆鍒嗗眰鍚堝苟鍚庢寜瀹夊叏涓婇檺閽冲埗锛岄挸鍒堕」鍐欒繘蹇収锛涙湭鐭ラ敭鎶ラ敊 | `domain/config/merge.ts` | `t04` |
| 浜虹被涓撳睘鍔ㄤ綔瀵逛换浣?agent 杩斿洖 `HUMAN_ONLY` | `domain/permissions/policy.ts` | `t04` |
| 椤圭洰閲嶅紑鍚庣殑鎶曞奖涓庡叧闂墠閫愬瓧娈典竴鑷?| `application/project-runtime.ts` | `t06` |
| 姣忎釜浜嬩欢绫诲瀷閮芥湁鎶曞奖澶勭悊锛堢洰褰曚笌 switch 涓嶆紓绉伙級 | `application/projections/project-state.ts` | `t07` |
| Run 瀹炰緥鍖?= 涓€涓師瀛愭壒娆★紱瀹屾垚鏉′欢婊¤冻鏃跺悓鎵规鍏?Run | `application/run-commands.ts`銆乣task-commands.ts` | `t08` |
| 瀹屾垚涓€涓换鍔℃椂鍚屾壒娆℃斁寮€宸叉弧瓒充緷璧栫殑涓嬫父浠诲姟 | `application/task-commands.ts` | `t08` |
| 鐭ヨ瘑鎻愭蹇呴』鏈夎瘉鎹紱鎻愭涓庨噰绾冲垎绂?| `application/knowledge-commands.ts` | `t09` |
| 閰嶇疆 rebase 蹇呴』甯?`expectedConfigRevision` | `application/commands.ts` | `t09` |
| Effect 鍙兘 `requested鈫抋ccepted鈫抍ompleted`锛涙湭鐭ョ粨鏋滀笉閲嶆斁 | `application/effect-commands.ts` | `t10` |
| v1 鍒嗘瀽锛氭湭鐭ヤ簨浠?搴忓彿鏂闃绘柇锛岀储寮曞鍎垮彧鍛婅 | `infrastructure/migration/v1/analyze.ts` | `t11` |
| 宸ュ叿韬唤鍙潵鑷細璇濈粦瀹氾紱鏈煡浼氳瘽 = FORBIDDEN | `application/actor-resolution.ts` | `t12` |
| 闃熼暱 12 涓伐鍏枫€佹垚鍛?3 涓伐鍏凤紝浜掍笉娉勬紡 | `composition/host.ts`銆乣composition/member.ts` | `t12` |
| 鍚屼竴宸ヤ綔鍖哄彧寮€涓€涓」鐩繍琛屾椂锛堝苟鍙戞墦寮€鎶樺彔涓轰竴涓?Promise锛?| `infrastructure/dsh/project-hosts.ts` | `t12` |
| 杩佺Щ褰卞搷闈㈠彲澶嶇幇锛欳LI 涓庢姤鍛婂悓涓€缁撴瀯锛岄樆鏂椂涓嶇粰瀵煎叆椤哄簭 | `infrastructure/migration/v1/report.ts` | `t13` |
| 闈㈡澘鍙鏈嶅姟锛氬崗璁増鏈笉鍖归厤鍗虫嫆缁濓紝鏈煡鏂规硶/缂哄弬鏁扮粨鏋勫寲鎶ラ敊 | `application/panel-service.ts` | `t14` |
| 浜虹被纭浠ょ墝缁戝畾 operationId/action/targetHash/impactHash/涓€娆℃€?nonce | `domain/permissions/human-authorizer.ts` | `t15` |
| 瑙ｆ暎鍥㈤槦/闃熼暱鎺ョ锛氶瑙?鈫?纭 鈫?鎵ц锛涘奖鍝嶉潰鍙樺寲鍗冲け鏁?| `application/human-actions.ts` | `t16` |
| 鍊欓€夊鍏ュ彧鏀寔宸茬‘璁ょ殑浜嬩欢褰㈢姸锛涘叾浠栦簨浠堕樆鏂€岄潪璺宠繃 | `infrastructure/migration/v1/convert.ts` | `t18` |
| 鍊欓€夊啓鍏ュ悗浠庣鐩橀噸鏀惧璐︼紝鏁伴噺涓嶇鍗冲け璐?| `infrastructure/migration/v1/convert.ts` | `t18` |
| 浠诲姟鎸夌粓鎬佹姌鍙犺縼绉伙紱鍦ㄩ€旀墽琛屽洖钀?ready锛屾棫 Attempt 涓嶈縼绉?| `infrastructure/migration/v1/convert.ts` | `t18` |
| 鐭ヨ瘑淇濈暀銆屾彁妗堚啋閲囩撼銆嶉摼锛涜椹冲洖鐨勬彁妗堜笉杩佺Щ | `infrastructure/migration/v1/convert.ts` | `t18` |
| cutover 鍓嶅繀椤昏瘉鏄庡€欓€夋湭杩囨湡锛堟潵婧?hash 瀵瑰緱涓婏級 | `infrastructure/migration/v1/cutover.ts` | `t19` |
| 璁板繂灞炰簬 bank 涓嶅睘浜庝細璇濓紱璺?bank 璇诲彇瑙嗕负涓嶅瓨鍦紱纭垹闄や粎浜虹被 | `infrastructure/memory-store/sqlite-memory.ts` | `t20` |

## 杩愯

```bash
cd plugin
node --test test/*.test.ts        # 109 涓祴璇?node ../tools/check-architecture.mjs   # ARCH_OK files=47 violations=0
node scripts/build-lib.mjs        # 47 涓ā鍧?鈫?lib/锛堝叆鍙?lib/composition/host.mjs锛?node ../tools/gen-panel-contract.mjs --check   # 闈㈡澘濂戠害鏂囨。涓庝唬鐮佷竴鑷?
# v1 鏁版嵁鍙鍒嗘瀽锛堜笉鍐欐棫鏂囦欢銆佷笉杩佺Щ锛?node ../tools/myteam-migrate.mjs analyze --root "E:\Workplace\extension\dsh-myteam"
node ../tools/myteam-migrate.mjs plan    --root "E:\Workplace\extension\dsh-myteam" --json
# 鍊欓€夊鍏ワ細鍐欏埌涓€涓嫭绔嬬洰褰曪紝鏃у伐浣滃尯涓嶅姩锛涘啓瀹岀珛鍗冲璐?node ../tools/myteam-migrate.mjs candidate --root "E:\Workplace\extension\dsh-myteam" --candidate "<鍊欓€夌洰褰?"
# cutover 璁″垝锛氭鏌ュ€欓€夊畬鏁存€с€佹簮鏄惁鍙樺寲銆佸垪鍑烘楠や笌鍥炴粴杈圭晫锛堜笉鎵ц鍒囨崲锛?node ../tools/myteam-migrate.mjs cutover-plan --root "E:\Workplace\extension\dsh-myteam" --candidate "<鍊欓€夌洰褰?"
```

涓嶉渶瑕?`npm install`锛歂ode 鈮?22.18 鐩存帴鎿﹂櫎绫诲瀷杩愯 `.ts`锛屼粨搴撲繚鎸侀浂杩愯鏃朵緷璧栥€?
## 鏁版嵁甯冨眬锛坴2 鐩爣锛孯6 杩佺Щ鍚庣敓鏁堬級

```text
<project>/.dsh-myteam/
鈹溾攢鈹€ manifest.json          # projectId銆乴ayoutVersion銆乻chemaVersion
鈹溾攢鈹€ events/project.jsonl   # 椤圭洰鍞竴涓氬姟浜嬪疄婧愶紙鍘熷瓙鎵规锛?鈹溾攢鈹€ config/                # 鐢熸垚瑙嗗浘锛岀姝㈢洿鎺ュ啓
鈹溾攢鈹€ memory/memory.db       # 闀挎湡璁板繂鍞竴鏉冨▉锛圧3锛?鈹溾攢鈹€ state/projections/     # 鍙噸寤虹紦瀛?鈹斺攢鈹€ state/writer.lock      # 鍐欒€呭崗璋冿紝涓嶆槸涓氬姟浜嬪疄
```

## 鏄庣‘涓嶅仛

- 鍚姩鏃惰嚜鍔ㄦ埅鏂€岀湅璧锋潵鍧忎簡銆嶇殑鏃ュ織鈥斺€旀挄瑁傚熬閮ㄥ繀椤绘樉寮忎慨澶嶅苟鐣欐姤鍛婏紱
- 鎶娿€岃繑鍥炲け璐ャ€嶅綋鎴愩€屽彲鑳藉啓杩涘幓浜嗐€嶁€斺€攄urable 涔嬪墠鐨勫け璐ヤ笉浜х敓浠讳綍鎶曞奖鍙樺寲锛?- 鐢?`actor:'human'` 鎴?`confirm:true` 鍙傛暟鍏呭綋浜虹被鎺堟潈鈥斺€旈偅鍙槸鏅€氭暟鎹紱
- 涓や釜杩涚▼鍚屾椂鍐欏悓涓€椤圭洰鈥斺€旀湭鍙栧緱绉熺害鍙鎴栬浆鍙戯紱
- 鏂版棫瀛樺偍闀挎湡鍙屽啓銆?
## 涓嬩竴闃舵

1. **R3 搴旂敤鐢ㄤ緥**锛歐orkflow Run銆佷緷璧栭噸鎺ャ€侀棬绂佽鍐炽€佺煡璇嗐€侀厤缃?rebase銆丒ffect 璇锋眰/瀵硅处锛?2. **R4 DSH 閫傞厤鍣?*锛歊oot Runtime銆丆aptain/Member preset銆佸伐鍏锋敞鍐屻€丼essionRef銆丠umanAuthorizer锛?3. **R5 v2 闈㈡澘**锛氬彧娑堣垂 RPC 鐨勭粺涓€鎶曞奖锛堣璁＄瑙?`design-v2/`锛夛紱
4. **R6 杩佺Щ**锛歚.team-workplace/`銆佷袱澶勬棫璐︽湰銆丼QLite銆乵emory.md 鐨勪竴娆℃€у€欓€夊鍏ヤ笌瀵硅处锛?5. **R7 楠屾敹涓庢竻鐞?*锛氱湡鏈洪摼璺€佹枃妗ｆ浛鎹€佸巻鍙茶祫鏂欏垹闄ゃ€