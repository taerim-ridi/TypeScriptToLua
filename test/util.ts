/* eslint-disable jest/no-standalone-expect */
import * as nativeAssert from "assert";
import { lauxlib, lua, lualib, to_jsstring, to_luastring } from "fengari";
import * as fs from "fs";
import { stringify } from "javascript-stringify";
import * as path from "path";
import * as prettyFormat from "pretty-format";
import * as ts from "typescript";
import * as vm from "vm";
import * as tstl from "../src";
import { createEmitOutputCollector } from "../src/transpilation/output-collector";

export function toByteCode(luaCode: string) {
    const L = lauxlib.luaL_newstate();

    if (lauxlib.luaL_loadstring(L, to_luastring(luaCode)) !== lua.LUA_OK) throw Error(lua.lua_tojsstring(L, -1));

    const writer = (_: any, newBytes: Uint8Array, size: number, data: number[]) => {
        data.push(...newBytes.slice(0, size));
        return 0;
    };

    const data: number[] = [];

    const dumpExitCode = lua.lua_dump(L, writer, data, false);

    if (dumpExitCode !== 0) {
        throw Error("Unable to dump byte code");
    }

    return Uint8Array.from(data);
}

const jsonLib = fs.readFileSync(path.join(__dirname, "json.lua"), "utf8");
const jsonLibByteCode = toByteCode(jsonLib);

const luaLib = fs.readFileSync(path.resolve(__dirname, "../dist/lualib/lualib_bundle.lua"), "utf8");
const luaLibByteCode = toByteCode(luaLib);

// Using `test` directly makes eslint-plugin-jest consider this file as a test
const defineTest = test;

export function assert(value: any, message?: string | Error): asserts value {
    nativeAssert(value, message);
}

export const formatCode = (...values: unknown[]) => values.map(e => stringify(e)).join(", ");

export function testEachVersion<T extends TestBuilder>(
    name: string | undefined,
    common: () => T,
    special?: Record<tstl.LuaTarget, ((builder: T) => void) | boolean>
): void {
    for (const version of Object.values(tstl.LuaTarget) as tstl.LuaTarget[]) {
        const specialBuilder = special?.[version];
        if (specialBuilder === false) return;

        const testName = name === undefined ? version : `${name} [${version}]`;
        defineTest(testName, () => {
            const builder = common();
            builder.setOptions({ luaTarget: version });
            if (typeof specialBuilder === "function") {
                specialBuilder(builder);
            }
        });
    }
}

const memoize: MethodDecorator = (_target, _propertyKey, descriptor) => {
    const originalFunction = descriptor.value as any;
    const memoized = new WeakMap();
    descriptor.value = function (this: any, ...args: any[]): any {
        if (!memoized.has(this)) {
            memoized.set(this, originalFunction.apply(this, args));
        }

        return memoized.get(this);
    } as any;
    return descriptor;
};

export class ExecutionError extends Error {
    public name = "ExecutionError";
    // https://github.com/typescript-eslint/typescript-eslint/issues/1131
    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor(message: string) {
        super(message);
    }
}

export type ExecutableTranspiledFile = tstl.TranspiledFile & { lua: string; luaSourceMap: string };
export type TapCallback = (builder: TestBuilder) => void;
export abstract class TestBuilder {
    constructor(protected _tsCode: string) {}

    // Options

    // TODO: Use testModule in these cases?
    protected tsHeader = "";
    public setTsHeader(tsHeader: string): this {
        expect(this.hasProgram).toBe(false);
        this.tsHeader = tsHeader;
        return this;
    }

    private luaHeader = "";
    public setLuaHeader(luaHeader: string): this {
        expect(this.hasProgram).toBe(false);
        this.luaHeader += luaHeader;
        return this;
    }

    protected jsHeader = "";
    public setJsHeader(jsHeader: string): this {
        expect(this.hasProgram).toBe(false);
        this.jsHeader += jsHeader;
        return this;
    }

    protected abstract getLuaCodeWithWrapper(code: string): string;
    public setLuaFactory(luaFactory: (code: string) => string): this {
        expect(this.hasProgram).toBe(false);
        this.getLuaCodeWithWrapper = luaFactory;
        return this;
    }

    private semanticCheck = true;
    public disableSemanticCheck(): this {
        expect(this.hasProgram).toBe(false);
        this.semanticCheck = false;
        return this;
    }

    private options: tstl.CompilerOptions = {
        luaTarget: tstl.LuaTarget.Lua53,
        noHeader: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2017,
        lib: ["lib.esnext.d.ts"],
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        resolveJsonModule: true,
        experimentalDecorators: true,
        sourceMap: true,
    };
    public setOptions(options: tstl.CompilerOptions = {}): this {
        expect(this.hasProgram).toBe(false);
        Object.assign(this.options, options);
        return this;
    }

    protected mainFileName = "main.ts";
    public setMainFileName(mainFileName: string): this {
        expect(this.hasProgram).toBe(false);
        this.mainFileName = mainFileName;
        return this;
    }

    protected extraFiles: Record<string, string> = {};
    public addExtraFile(fileName: string, code: string): this {
        expect(this.hasProgram).toBe(false);
        this.extraFiles[fileName] = code;
        return this;
    }

    private customTransformers?: ts.CustomTransformers;
    public setCustomTransformers(customTransformers?: ts.CustomTransformers): this {
        expect(this.hasProgram).toBe(false);
        this.customTransformers = customTransformers;
        return this;
    }

    // Transpilation and execution

    public getTsCode(): string {
        return `${this.tsHeader}${this._tsCode}`;
    }

    protected hasProgram = false;
    @memoize
    public getProgram(): ts.Program {
        this.hasProgram = true;
        return tstl.createVirtualProgram({ ...this.extraFiles, [this.mainFileName]: this.getTsCode() }, this.options);
    }

    @memoize
    public getLuaResult(): tstl.TranspileVirtualProjectResult {
        const program = this.getProgram();
        const collector = createEmitOutputCollector();
        const { diagnostics: transpileDiagnostics } = new tstl.Transpiler().emit({
            program,
            customTransformers: this.customTransformers,
            writeFile: collector.writeFile,
        });

        const diagnostics = ts.sortAndDeduplicateDiagnostics([
            ...ts.getPreEmitDiagnostics(program),
            ...transpileDiagnostics,
        ]);

        return { diagnostics: [...diagnostics], transpiledFiles: collector.files };
    }

    @memoize
    public getMainLuaFileResult(): ExecutableTranspiledFile {
        const { transpiledFiles } = this.getLuaResult();
        const mainFile = this.options.luaBundle
            ? transpiledFiles[0]
            : transpiledFiles.find(({ sourceFiles }) => sourceFiles.some(f => f.fileName === this.mainFileName));
        expect(mainFile).toMatchObject({ lua: expect.any(String), luaSourceMap: expect.any(String) });
        return mainFile as ExecutableTranspiledFile;
    }

    @memoize
    public getMainLuaCodeChunk(): string {
        const header = this.luaHeader ? `${this.luaHeader.trimRight()}\n` : "";
        return header + this.getMainLuaFileResult().lua.trimRight();
    }

    @memoize
    public getLuaExecutionResult(): any {
        return this.executeLua();
    }

    @memoize
    public getJsResult(): tstl.TranspileVirtualProjectResult {
        const program = this.getProgram();
        program.getCompilerOptions().module = ts.ModuleKind.CommonJS;

        const collector = createEmitOutputCollector();
        const { diagnostics } = program.emit(undefined, collector.writeFile);
        return { transpiledFiles: collector.files, diagnostics: [...diagnostics] };
    }

    @memoize
    public getMainJsCodeChunk(): string {
        const { transpiledFiles } = this.getJsResult();
        const code = transpiledFiles.find(({ sourceFiles }) => sourceFiles.some(f => f.fileName === this.mainFileName))
            ?.js;
        assert(code !== undefined);

        const header = this.jsHeader ? `${this.jsHeader.trimRight()}\n` : "";
        return header + code;
    }

    protected abstract getJsCodeWithWrapper(): string;

    @memoize
    public getJsExecutionResult(): any {
        return this.executeJs();
    }

    // Utilities

    private getLuaDiagnostics(): ts.Diagnostic[] {
        const { diagnostics } = this.getLuaResult();
        return diagnostics.filter(
            d => (this.semanticCheck || d.source === "typescript-to-lua") && !this.ignoredDiagnostics.includes(d.code)
        );
    }

    // Actions

    public debug(): this {
        const transpiledFiles = this.getLuaResult().transpiledFiles;
        const luaCode = transpiledFiles.map(
            f => `[${f.sourceFiles.map(sf => sf.fileName).join(",")}]:\n${f.lua?.replace(/^/gm, "  ")}`
        );
        const value = prettyFormat(this.getLuaExecutionResult()).replace(/^/gm, "  ");
        console.log(`Lua Code:\n${luaCode.join("\n")}\n\nValue:\n${value}`);
        return this;
    }

    private diagnosticsChecked = false;
    private ignoredDiagnostics: number[] = [];

    public ignoreDiagnostics(ignored: number[]): this {
        this.ignoredDiagnostics.push(...ignored);
        return this;
    }

    public expectToHaveDiagnostics(expected?: number[]): this {
        if (this.diagnosticsChecked) return this;
        this.diagnosticsChecked = true;

        expect(this.getLuaDiagnostics()).toHaveDiagnostics(expected);
        return this;
    }

    public expectToHaveNoDiagnostics(): this {
        if (this.diagnosticsChecked) return this;
        this.diagnosticsChecked = true;

        expect(this.getLuaDiagnostics()).not.toHaveDiagnostics();
        return this;
    }

    public expectNoExecutionError(): this {
        const luaResult = this.getLuaExecutionResult();
        if (luaResult instanceof ExecutionError) {
            throw luaResult;
        }

        return this;
    }

    private expectNoJsExecutionError(): this {
        const jsResult = this.getJsExecutionResult();
        if (jsResult instanceof ExecutionError) {
            throw jsResult;
        }

        return this;
    }

    public expectToMatchJsResult(allowErrors = false): this {
        this.expectToHaveNoDiagnostics();
        if (!allowErrors) this.expectNoExecutionError();
        if (!allowErrors) this.expectNoJsExecutionError();

        const luaResult = this.getLuaExecutionResult();
        const jsResult = this.getJsExecutionResult();
        expect(luaResult).toEqual(jsResult);

        return this;
    }

    public expectToEqual(expected: any): this {
        this.expectToHaveNoDiagnostics();
        const luaResult = this.getLuaExecutionResult();
        expect(luaResult).toEqual(expected);
        return this;
    }

    public expectLuaToMatchSnapshot(): this {
        this.expectToHaveNoDiagnostics();
        expect(this.getMainLuaCodeChunk()).toMatchSnapshot();
        return this;
    }

    public expectDiagnosticsToMatchSnapshot(expected?: number[], diagnosticsOnly = false): this {
        this.expectToHaveDiagnostics(expected);

        const diagnosticMessages = ts.formatDiagnostics(
            this.getLuaDiagnostics().map(tstl.prepareDiagnosticForFormatting),
            { getCurrentDirectory: () => "", getCanonicalFileName: fileName => fileName, getNewLine: () => "\n" }
        );

        expect(diagnosticMessages.trim()).toMatchSnapshot("diagnostics");
        if (!diagnosticsOnly) {
            expect(this.getMainLuaCodeChunk()).toMatchSnapshot("code");
        }

        return this;
    }

    public tap(callback: TapCallback): this {
        callback(this);
        return this;
    }

    private executeLua(): any {
        // Main file
        const mainFile = this.getMainLuaCodeChunk();

        const L = lauxlib.luaL_newstate();
        lualib.luaL_openlibs(L);

        // Load modules
        // Json
        lua.lua_getglobal(L, "package");
        lua.lua_getfield(L, -1, "preload");
        lauxlib.luaL_loadstring(L, jsonLibByteCode);
        lua.lua_setfield(L, -2, "json");
        // Lua lib
        if (
            this.options.luaLibImport === tstl.LuaLibImportKind.Require ||
            mainFile.includes('require("lualib_bundle")')
        ) {
            lua.lua_getglobal(L, "package");
            lua.lua_getfield(L, -1, "preload");
            lauxlib.luaL_loadstring(L, luaLibByteCode);
            lua.lua_setfield(L, -2, "lualib_bundle");
        }

        // Extra files
        const { transpiledFiles } = this.getLuaResult();

        Object.keys(this.extraFiles).forEach(fileName => {
            const transpiledExtraFile = transpiledFiles.find(({ sourceFiles }) =>
                sourceFiles.some(f => f.fileName === fileName)
            );
            if (transpiledExtraFile?.lua) {
                lua.lua_getglobal(L, "package");
                lua.lua_getfield(L, -1, "preload");
                lauxlib.luaL_loadstring(L, to_luastring(transpiledExtraFile.lua));
                lua.lua_setfield(L, -2, fileName.replace(".ts", ""));
            }
        });

        // Execute Main
        const wrappedMainCode = `
local JSON = require("json");
return JSON.stringify((function()
    ${this.getLuaCodeWithWrapper(mainFile)}
end)());`;

        const status = lauxlib.luaL_dostring(L, to_luastring(wrappedMainCode));

        if (status === lua.LUA_OK) {
            if (lua.lua_isstring(L, -1)) {
                const result = eval(`(${lua.lua_tojsstring(L, -1)})`);
                return result === null ? undefined : result;
            } else {
                const returnType = to_jsstring(lua.lua_typename(L, lua.lua_type(L, -1)));
                throw new Error(`Unsupported Lua return type: ${returnType}`);
            }
        } else {
            // Filter out control characters appearing on some systems
            const luaStackString = lua.lua_tostring(L, -1).filter(c => c >= 20);
            const message = to_jsstring(luaStackString).replace(/^\[string "(--)?\.\.\."\]:\d+: /, "");
            return new ExecutionError(message);
        }
    }

    private executeJs(): any {
        const { transpiledFiles } = this.getJsResult();
        // Custom require for extra files. Really basic. Global support is hacky
        // TODO Should be replaced with vm.Module https://nodejs.org/api/vm.html#vm_class_vm_module
        // once stable
        const globalContext: any = {};
        const mainExports = {};
        globalContext.exports = mainExports;
        globalContext.module = { exports: mainExports };
        globalContext.require = (fileName: string) => {
            // create clean export object for "module"
            const moduleExports = {};
            globalContext.exports = moduleExports;
            globalContext.module = { exports: moduleExports };
            const transpiledExtraFile = transpiledFiles.find(({ sourceFiles }) =>
                sourceFiles.some(f => f.fileName === fileName.replace("./", "") + ".ts")
            );

            if (transpiledExtraFile?.js) {
                vm.runInContext(transpiledExtraFile.js, globalContext);
            }

            // Have to return globalContext.module.exports
            // becuase module.exports might no longer be equal to moduleExports (export assignment)
            const result = globalContext.module.exports;
            // Reset module/export
            globalContext.exports = mainExports;
            globalContext.module = { exports: mainExports };
            return result;
        };

        vm.createContext(globalContext);

        let result: unknown;
        try {
            result = vm.runInContext(this.getJsCodeWithWrapper(), globalContext);
        } catch (error) {
            return new ExecutionError(error.message);
        }

        function removeUndefinedFields(obj: any): any {
            if (obj === null) {
                return undefined;
            }

            if (Array.isArray(obj)) {
                return obj.map(removeUndefinedFields);
            }

            if (typeof obj === "object") {
                const copy: any = {};
                for (const [key, value] of Object.entries(obj)) {
                    if (obj[key] !== undefined) {
                        copy[key] = removeUndefinedFields(value);
                    }
                }

                if (Object.keys(copy).length === 0) {
                    return [];
                }

                return copy;
            }

            return obj;
        }

        return removeUndefinedFields(result);
    }
}

class AccessorTestBuilder extends TestBuilder {
    protected accessor = "";

    protected getLuaCodeWithWrapper(code: string) {
        return `return (function()\n${code}\nend)()${this.accessor}`;
    }

    @memoize
    protected getJsCodeWithWrapper(): string {
        return this.getMainJsCodeChunk() + `\n;module.exports = module.exports${this.accessor}`;
    }
}

class BundleTestBuilder extends AccessorTestBuilder {
    constructor(_tsCode: string) {
        super(_tsCode);
        this.setOptions({ luaBundle: "main.lua", luaBundleEntry: this.mainFileName });
    }

    public setEntryPoint(fileName: string): this {
        return this.setOptions({ luaBundleEntry: fileName });
    }
}

class ModuleTestBuilder extends AccessorTestBuilder {
    public setReturnExport(...names: string[]): this {
        expect(this.hasProgram).toBe(false);
        this.accessor = names.map(n => `[${tstl.escapeString(n)}]`).join("");
        return this;
    }
}
class FunctionTestBuilder extends AccessorTestBuilder {
    protected accessor = ".__main()";
    public getTsCode(): string {
        return `${this.tsHeader}export function __main() {${this._tsCode}}`;
    }
}

class ExpressionTestBuilder extends AccessorTestBuilder {
    protected accessor = ".__result";
    public getTsCode(): string {
        return `${this.tsHeader}export const __result = ${this._tsCode};`;
    }
}

const createTestBuilderFactory = <T extends TestBuilder>(
    builder: new (_tsCode: string) => T,
    serializeSubstitutions: boolean
) => (...args: [string] | [TemplateStringsArray, ...any[]]): T => {
    let tsCode: string;
    if (typeof args[0] === "string") {
        expect(serializeSubstitutions).toBe(false);
        tsCode = args[0];
    } else {
        let [raw, ...substitutions] = args;
        if (serializeSubstitutions) {
            substitutions = substitutions.map(s => formatCode(s));
        }

        tsCode = String.raw(Object.assign([], { raw }), ...substitutions);
    }

    return new builder(tsCode);
};

export const testBundle = createTestBuilderFactory(BundleTestBuilder, false);
export const testModule = createTestBuilderFactory(ModuleTestBuilder, false);
export const testModuleTemplate = createTestBuilderFactory(ModuleTestBuilder, true);
export const testFunction = createTestBuilderFactory(FunctionTestBuilder, false);
export const testFunctionTemplate = createTestBuilderFactory(FunctionTestBuilder, true);
export const testExpression = createTestBuilderFactory(ExpressionTestBuilder, false);
export const testExpressionTemplate = createTestBuilderFactory(ExpressionTestBuilder, true);
