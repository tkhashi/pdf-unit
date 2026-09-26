import { describe, expect, it } from "vitest";
import { luminance, shade } from "./color";

describe("濃淡", () => {
  it("輝度から5%刻みの濃度を返す", () => {
    expect(shade("rgb(0,0,0)")).toBe("濃度100%");
    expect(shade("rgb(255,255,255)")).toBe("濃度0%");
    expect(shade("rgb(128,128,128)")).toBe("濃度50%");
  });

  it("rgb() 以外(空白入りを含む)は判定しない", () => {
    expect(luminance(null)).toBeNull();
    expect(luminance("rgb(1, 2, 3)")).toBeNull();
    expect(shade("#000")).toBeNull();
  });
});
