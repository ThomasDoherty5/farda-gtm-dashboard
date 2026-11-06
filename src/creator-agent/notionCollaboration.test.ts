// @vitest-environment node
import { describe,it,expect } from "vitest";
import { projectNotionCollaboration } from "./notionCollaboration.ts";
import { createNotionDriveAssetSource } from "./notionDriveAssetSource.ts";
import { collabTestScope as scope,collabTestAt } from "./collaborationWorkflowFixtures.ts";
const id=(n:number)=>"20000000-0000-4000-8000-"+String(n).padStart(12,"0");
const collabs=id(1),content=id(2),target=id(3),asset=id(4);
const date=(start:string)=>({type:"date",date:{start,end:null,time_zone:null}});
const row=(id:string,parent:string,properties:Record<string,unknown>)=>({object:"page",id,parent:{type:"data_source_id",data_source_id:parent},
  in_trash:false,last_edited_time:collabTestAt,properties});
const collab=row(target,collabs,{Name:{type:"title",title:[{plain_text:"Synthetic agreement"}]},"Agreement evidence":{type:"url",url:"https://example.test/terms"},
  "Agreement type":{type:"select",select:{name:"Gift — no posting obligation"}},Agreed:date("2026-10-01"),"Observation due":date("2026-11-01"),Delivered:date("2026-10-08")});
const material=row(asset,content,{Collaboration:{type:"relation",relation:[{id:target}]},"Status":{type:"status",status:{name:"Live"}},
  "Published":date("2026-10-30"),"Live URL":{type:"url",url:"https://example.test/post"},"Ad rights approved":{type:"checkbox",checkbox:true},"Rights expire":date("2026-12-31")});
const list=(results:unknown[],overrides={})=>({object:"list",results,has_more:false,next_cursor:null,...overrides});
const setup=(respond:(url:URL,body:Record<string,unknown>|null)=>Response,token:string|null="test-read")=>createNotionDriveAssetSource({
  scope:{workspaceId:scope.workspaceId,accountId:scope.accountId},notionToken:async()=>token,collaborationDataSourceId:collabs,contentDataSourceId:content
},{fetch:async(u,opts)=>respond(u as URL,opts?.body ? JSON.parse(String(opts.body)):null),clock:()=>collabTestAt});
describe("existing native registry as the collaboration source",()=>{
  it("uses the fixed collections and exact relation, preserves voluntary terms, and never converts a mirror post/rights flag into native proof",async()=>{
    const seen:string[]=[];
    const provider=setup((url,body)=>{
      seen.push(url.pathname);expect(url.origin).toBe("https://api.notion.com");
      if(url.pathname.endsWith(collabs+"/query"))return Response.json(list([collab]));
      if(url.pathname.endsWith(content+"/query")){expect(body?.filter).toEqual({property:"Collaboration",relation:{contains:target}});return Response.json(list([material]));}
      return Response.json(collab);
    });
    const data=await provider.readCollaborationSnapshot(scope,target,"server-secret");
    expect(seen).toHaveLength(3);expect(data).toMatchObject({coverage:"complete",terms:{posting:"voluntary",due:null,graceDays:null,observationUntil:"2026-11-01"},
      suppression:{state:"unknown"},sample:{state:"Delivery recorded"}});
    expect(data!.deliverables[0]).toMatchObject({stage:"Live",submissionVersion:null,reportedPublishedAt:"2026-10-30",reportedLink:true,
      reportedRightsExpiry:"2026-12-31",rights:{state:"unknown"},publication:{state:"unknown",nativePostRef:null}});
    expect(JSON.stringify(data)).not.toContain("https://example.test");
  });
  it.each([null,"Unrecognized type","Paid deliverables","Affiliate collaboration"])("a due date beside agreement type %s does not prove a posting obligation",kind=>{
    const props={...collab.properties,"Agreement type":{type:"select",select:kind?{name:kind}:null},"Posting due":date("2026-10-23"),"Grace days":{type:"number",number:2}};
    const projected=projectNotionCollaboration(scope,{...collab,properties:props},[],"complete",collabTestAt,id=>id);
    expect(projected.terms).toMatchObject({posting:"unknown",due:null,graceDays:null});
  });
  it("distinguishes a complete empty lookup from incomplete reads, changed versions, wrong relation and missing access",async()=>{
    expect(await setup(()=>Response.json(list([]))).readCollaborationSnapshot(scope,target)).toBeNull();
    await expect(setup(()=>Response.json(list([],{request_status:{type:"incomplete"}}))).readCollaborationSnapshot(scope,target)).rejects.toMatchObject({code:"SOURCE_COVERAGE_INCOMPLETE"});
    await expect(setup(()=>Response.json(list([])),null).readCollaborationSnapshot(scope,target)).rejects.toMatchObject({code:"SOURCE_ACCESS_UNAVAILABLE"});
    await expect(setup(()=>Response.json(list([]))).readCollaborationSnapshot({...scope,accountId:"other"},target)).rejects.toMatchObject({status:403});
    await expect(setup(url=>url.pathname.includes("pages/")?Response.json({...collab,last_edited_time:"2026-11-06T18:00:01Z"}):
      Response.json(list(url.pathname.endsWith(collabs+"/query")?[collab]:[]))).readCollaborationSnapshot(scope,target)).rejects.toMatchObject({code:"SOURCE_VERSION_CHANGED"});
    await expect(setup(url=>Response.json(list(url.pathname.endsWith(collabs+"/query")?[collab]:[row(asset,content,{Collaboration:{type:"relation",relation:[{id:id(8)}]}})])))
      .readCollaborationSnapshot(scope,target)).rejects.toMatchObject({code:"SOURCE_RESPONSE_INVALID"});
  });
});
