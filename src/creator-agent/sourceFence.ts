/** A final source assertion must complete before its caller's effect transaction.
 * TypeScript allows async implementations of void callbacks, so enforce it at runtime.
 */
export function assertSynchronousVoid(callback:()=>unknown):void {
  const result=callback();
  if(result===undefined)return;
  if(result!==null && (typeof result==="object" || typeof result==="function") && "then" in result)
    void Promise.resolve(result).catch(()=>{});
  throw new Error("Source authority requires a synchronous void assertion.");
}
