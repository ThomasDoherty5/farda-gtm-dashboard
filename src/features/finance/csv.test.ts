import { csvCell, toCsv } from "./csv";

describe("CSV export", () => {
  it("neutralizes text that a spreadsheet would run as a formula", () => {
    for (const risky of ["=1+1", "+SUM(A1)", "-2+3", "@cmd", "\tx", "\rx"]) expect(csvCell(risky).replace(/^"|"$/g, "").startsWith("'")).toBe(true);
    expect(csvCell("COMM-DEMO-A")).toBe("COMM-DEMO-A");
  });

  it("keeps real negative numbers as numbers", () => {
    expect(csvCell(-3000)).toBe("-3000");
    expect(csvCell(0)).toBe("0");
  });

  it("quotes commas, quotes and newlines, and doubles embedded quotes", () => {
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
    expect(csvCell(null)).toBe("");
  });

  it("writes a header and CRLF rows", () => {
    expect(toCsv(["a", "b"], [[1, "x,y"], [2, null]])).toBe('a,b\r\n1,"x,y"\r\n2,\r\n');
  });
});
