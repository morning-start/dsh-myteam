/**
 * CHG-186（T155a）：宿主契约（**只有类型，零运行时**）。
 *
 * ── 为什么单独成文件 ────────────────────────────────────────────────────────────
 * `remote/service.ts` 需要 `MyTeamHost` 的类型，但它原来从 `../host.ts` 取，而
 * `host.ts` 又 import `remote/service.ts` 的实现（`import * as remoteServiceModule`）——
 * 于是形成 `host.ts ⇄ remote/service.ts` 的 type 环（`arch-report` 里唯一那条
 * 「环形依赖 — 仅 type 边: 1」）。类型擦除后运行时无害，但接口耦合会让「谁能依赖谁」
 * 说不清：改一次 `MyTeamHost` 的方法签名，面板远程面与宿主装配层会一起连带。
 *
 * 把接口沉到 core 层后，依赖图变成：
 *   core/host/contract.ts  ←（type）-- remote/service.ts
 *                          ←（type）-- host.ts
 * 环消失，且 core/ 仍然不 import 入口层（`tools/check-architecture.mjs` 的 A1 门禁继续绿）。
 *
 * ── 搬运纪律（T155a）────────────────────────────────────────────────────────────
 *  - **只搬类型声明，一个字段名都不改**：这里逐字复制 `host.ts` 里已有的方法签名
 *    （含参数名与默认值语义），不新增、不重命名、不改窄/改宽。
 *  - **接口里没有实现**：真正的实现仍在 `MyTeamHost`（`host.ts`），它 `implements` 本接口。
 *  - T155b 每搬走一族端点实现，就把该族成员从本接口挪到 `src/host/<族>.ts` 的适配器契约里；
 *    本文件只保留「跨族编排 + 装配」需要的面。
 *  - 本文件只允许 `import type`（含 `typeof` 类型查询）——一旦出现值 import，`core` 就会
 *    在运行时装到上层实现，A1 的「core 可独立装载」前提立刻失效。
 */
                                                             
                                                               
                                                            
                                                              
                                                                       
                                                     
                                                                       

/**
 * 行 config（cordis.patch.yml myteam-host.config；全部可省）。
 *
 * CHG-186：**逐字搬自** `host.ts`（原第 200–249 行），一个字段都没改。搬下来的原因：
 * 契约里的 `config` 成员要它的类型，而 `core/**` **不许** import `../host.ts`（A1）。
 * `host.ts` 仍 `export type { MyTeamConfig }` re-export，既有 import 点（`test/t123`）不用动。
 */
                               
                                                          
                                
     
                           
    
                                                       
                                         
     
                        
                                                                 
                         
                                                                       
                          
     
                                                        
                                                            
                                                                
                                                                
                                                    
                                                       
     
                   
     
                          
                                                 
                                                
                               
     
                                 
                                   
     
                                                      
    
                                                            
                                                     
                                                    
     
                            
     
                                                                       
                                                               
    
                                             
                                                  
                                 
     
                             
 

/**
 * 知识库面板视图（FR-17.5，M2-0b）：纯读投影。
 *
 * CHG-186：**逐字搬自** `host.ts` 里 `buildKnowledgeView()` 的返回类型（原第 558–562 行）。
 * 搬下来的原因同上：契约要声明 `knowledgeView()` 的显式返回类型，而 `core/**` 不许
 * import 入口层。`buildKnowledgeView` 现在标注 `: KnowledgeView`，两边不可能再漂移。
 */
                                
                  
              
                 
                  
                      
                      
                                   
                      
                       
                       
                 
                        
                   
                
    
                    
                  
                   
                 
                  
                    
                     
                      
              
                      
                                   
    
                                                                                                                
 

/**
 * `remote/service.ts` 用到的宿主面（**只列被用到的成员**，不做全能门面）。
 *
 * 口径：`grep "this.host\." src/remote/service.ts` 的 28 个成员 + 两个只读属性
 * （`config` / `workspaceRoot`）。面板远程面只读投影、写一律经 `executeLeadTool` 同一条
 * 单写者管线，所以它需要的正好是「TeamService 取用 + 队长工具分发 + 几个只读视图」。
 */
                                     
                                                          
                               
     
                                                             
                                                              
     
                                
                                                          
                                                                                                                 

                                                
                         

                                                              
                                      

                                
                                                                               

                                                                      
                  
                 
                                  
                                                                            
                                                               

                                                                              
           
                   
                     
               
                     
                                                    
                            

                                                              
                                                                                

                                                                
                            
                  
              
                
                       
                      
                           
                    
                          
                                               
                   
    

                                                            
                                

                                                           
                                    

                                    
                                             

                                      
                                            

                                                  
                                                                           

                                                    
                                                                         

                                                        
                                                                                

                                                         
                                                                                   

                                                             
                                                                         

                                               
                                                                                  

                                                                
                                                                          

                                                      
                                                                         

                                                            
                                                                                      

                                                  
                                                                               

                                                         
                                                                                        

                                                       
                                                                                         

                                              
                                                                                                                              

                                      
                                                                       

                                        
                                        
 


//# sourceURL=./src/core/host/contract.ts