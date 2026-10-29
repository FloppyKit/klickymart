import { describe, it, expect } from "vitest";
import kmCss from "../../public/km.css?raw";
import tokensCss from "../../public/tokens.css?raw";

const LIGHT_HEX = /#(?:fff(?:fff)?|f{3,8}|ffffff|fefefe|f6f5f3|f3f2ee|f8f7f4)/i;

describe("km.css dark theme rule", () => {
  it("has no bare light hex outside light blocks", () => {
    const css = kmCss;
    const tokens = tokensCss;
    const lightBlocks = (css + tokens).split(/\[(data-theme="light"|prefers-color-scheme:\s*light)/);
    const darkPart = lightBlocks[0] ?? css;
    const matches = darkPart.match(/#[0-9a-fA-F]{3,8}/g) ?? [];
    for (const m of matches) {
      if (LIGHT_HEX.test(m)) {
        throw new Error(`light color in dark CSS: ${m}`);
      }
    }
  });
});
