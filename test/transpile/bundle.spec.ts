import * as path from "path";
import * as util from "../util";
import { transpileProjectResult } from "./run";

const projectDir = path.join(__dirname, "bundle");
const inputProject = path.join(projectDir, "tsconfig.json");

test("should transpile into one file", () => {
    const { diagnostics, emittedFiles } = transpileProjectResult(inputProject);

    expect(diagnostics).not.toHaveDiagnostics();
    expect(emittedFiles).toHaveLength(1);

    const { name, text } = emittedFiles[0];
    // Verify the name is as specified in tsconfig
    expect(name).toBe("bundle/bundle.lua");
    // Verify exported module by executing
    // Use an empty TS string because we already transpiled the TS project
    util.testModule("").setLuaHeader(text).expectToEqual({ myNumber: 3 });
});
