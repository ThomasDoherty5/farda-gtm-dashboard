import { expect, test } from "@playwright/test";
const routes=[{name:"social-cat",path:"/creators/social-cat/recruitment",heading:"Find the right creators. Move every match forward."},{name:"invitation",path:"/creators/tiktok/invitations/new",heading:"One precise request. A verifiable outcome."},{name:"batch",path:"/batches/demo-batch-tt-024",heading:"Scale the work. Keep control."}];
test("full fictional recruitment layouts remain available for private original-source comparison",async({page},info)=>{
  test.skip(info.project.name!=="desktop-1440","Original source canvas is 1440 px; responsive journeys are covered separately.");
  for(const route of routes){await page.goto(route.path);await expect(page.getByRole("heading",{name:route.heading,exact:true})).toBeVisible();await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:info.outputPath(`recruitment-original-layout-demo-${route.name}.png`),fullPage:true});}
});
