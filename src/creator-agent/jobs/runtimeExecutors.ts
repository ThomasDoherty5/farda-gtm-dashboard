import { runtimeStepSchema, RuntimeError, type RuntimeExecutionContext, type RuntimeExecutor } from "./runtimeSchema.ts";

type Mode=RuntimeExecutor["mode"];
function configuredUrl(endpoint:string,allowSyntheticLoopback=false){const url=new URL(endpoint);if(url.username||url.password||url.hash||url.search||!(url.protocol==="https:"||allowSyntheticLoopback&&url.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(url.hostname)))throw new RuntimeError("RUNTIME_ENDPOINT_INVALID",422);return url;}
function queryUrl(base:URL,c:RuntimeExecutionContext){const url=new URL(base);url.searchParams.set("subject",c.subjectRef);url.searchParams.set("start",c.window.windowStart);url.searchParams.set("end",c.window.windowEnd);url.searchParams.set("limit",String(c.maxRecords));if(c.cursor)url.searchParams.set("cursor",c.cursor);return url;}
async function boundedJson(response:Response,maxBytes:number){if(!response.body)throw new RuntimeError("SOURCE_RESPONSE_INVALID",502);const reader=response.body.getReader();let bytes=0;const chunks:Uint8Array[]=[];try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>maxBytes){await reader.cancel();throw new RuntimeError("SOURCE_RESPONSE_TOO_LARGE",502);}chunks.push(part.value);}}finally{reader.releaseLock();}const all=new Uint8Array(bytes);let offset=0;for(const c of chunks){all.set(c,offset);offset+=c.byteLength;}try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(all)) as unknown;}catch{throw new RuntimeError("SOURCE_RESPONSE_INVALID",502);}}
/** A real bounded GET transport. Endpoint/headers are server configuration, never a job/source input. */
export function createJsonReadExecutor(options:{mode:Mode;endpoint:string;headers?:Readonly<Record<string,string>>;fetch?:typeof fetch;allowSyntheticLoopback?:boolean;timeoutMs?:number;maxBytes?:number}):RuntimeExecutor{
  const base=configuredUrl(options.endpoint,options.allowSyntheticLoopback),timeout=options.timeoutMs??10000,maxBytes=options.maxBytes??65536;
  if(!Number.isSafeInteger(timeout)||timeout<100||timeout>30000||!Number.isSafeInteger(maxBytes)||maxBytes<1024||maxBytes>262144)throw new RuntimeError("RUNTIME_TRANSPORT_BOUND_INVALID",422);
  return{mode:options.mode,execute:async c=>{
    const url=queryUrl(base,c);c.assertCurrent();
    return c.invoke(c.registration.apiChannel,async()=>{
      const response=await(options.fetch??fetch)(url,{method:"GET",headers:options.headers,redirect:"error",signal:AbortSignal.timeout(timeout)});
      if(response.status===401||response.status===403)throw new RuntimeError("SOURCE_SCOPE_DENIED",403);
      if(response.status===429||response.status>=500){const raw=response.headers.get("retry-after");const seconds=raw!==null&&/^\d+$/.test(raw)?Number(raw):null;const date=raw?Date.parse(raw):NaN;const retryAfterMs=seconds!==null?seconds*1000:Number.isFinite(date)?Math.max(0,date-Date.now()):1000;return{state:"retry",reasonCode:response.status===429?"SOURCE_RATE_LIMITED":"SOURCE_READ_UNAVAILABLE",retryAfterMs:Math.min(3600000,retryAfterMs)};}
      if(!response.ok)throw new RuntimeError("SOURCE_READ_REJECTED",422);
      const parsed=runtimeStepSchema.safeParse(await boundedJson(response,maxBytes));if(!parsed.success)throw new RuntimeError("SOURCE_RESPONSE_INVALID",502);c.assertCurrent();return parsed.data;
    });
  }};
}

/** Minimal browser driver implemented by the configured browser worker (a Playwright Page satisfies this shape). */
export type RuntimeBrowserPage={goto(url:string,options:{waitUntil:"domcontentloaded";timeout:number}):Promise<unknown>;url():string;
  locator(selector:string):{count():Promise<number>;getAttribute(name:string):Promise<string|null>;textContent():Promise<string|null>}};
/** Finite read-only browser workflow. Authentication, CAPTCHA and source UI changes never trigger automatic clicks or a route bypass. */
export function createBrowserReadExecutor(options:{mode:Mode;endpoint:string;page:RuntimeBrowserPage;pageVersion:string;ownerRef:string;handoffRef:string;allowSyntheticLoopback?:boolean}):RuntimeExecutor{
  const base=configuredUrl(options.endpoint,options.allowSyntheticLoopback);
  return{mode:options.mode,execute:async c=>c.invoke("browser",async()=>{
    c.assertCurrent();await options.page.goto(queryUrl(base,c).href,{waitUntil:"domcontentloaded",timeout:10000});c.assertCurrent();
    const current=new URL(options.page.url());if(current.origin!==base.origin||current.pathname!==base.pathname)throw new RuntimeError("SOURCE_BROWSER_DESTINATION_CHANGED",403);
    const root=options.page.locator("[data-runtime-reader]");if(await root.count()!==1)return{state:"takeover",kind:"uiDrift",reasonCode:"SOURCE_UI_DRIFT",ownerRef:options.ownerRef,handoffRef:options.handoffRef};
    const version=await root.getAttribute("data-runtime-version"),state=await root.getAttribute("data-runtime-state");c.assertCurrent();
    if(state==="denied")throw new RuntimeError("SOURCE_SCOPE_DENIED",403);
    const takeover={login:"login",mfa:"mfa",captcha:"captcha",termsChanged:"termsChanged"} as const;
    if(state&&Object.hasOwn(takeover,state))return{state:"takeover",kind:takeover[state as keyof typeof takeover],reasonCode:`SOURCE_${state.replace(/([a-z])([A-Z])/g,"$1_$2").toUpperCase()}`,ownerRef:options.ownerRef,handoffRef:options.handoffRef};
    if(version!==options.pageVersion||state!=="ready")return{state:"takeover",kind:"uiDrift",reasonCode:"SOURCE_UI_DRIFT",ownerRef:options.ownerRef,handoffRef:options.handoffRef};
    const result=options.page.locator("[data-runtime-result]");if(await result.count()!==1)throw new RuntimeError("SOURCE_RESPONSE_INVALID",502);const text=await result.textContent();c.assertCurrent();if(!text||new TextEncoder().encode(text).length>65536)throw new RuntimeError("SOURCE_RESPONSE_INVALID",502);
    let raw:unknown;try{raw=JSON.parse(text);}catch{throw new RuntimeError("SOURCE_RESPONSE_INVALID",502);}const parsed=runtimeStepSchema.safeParse(raw);if(!parsed.success)throw new RuntimeError("SOURCE_RESPONSE_INVALID",502);return parsed.data;
  })};
}
