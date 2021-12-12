/*
    MIT License

    Copyright (c) 2019 github0null

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
*/

import { ProjectType, ICompileOptions } from "./EIDETypeDefine";
import { File } from "../lib/node-utility/File";
import { SettingManager } from "./SettingManager";
import { ResManager } from "./ResManager";
import { GlobalEvent } from "./GlobalEvents";
import { newMessage, ExceptionToMessage } from "./Message";

import * as child_process from 'child_process';
import { CmdLineHandler } from "./CmdLineHandler";
import * as fs from 'fs';
import * as events from 'events';
import * as NodePath from 'path';

export type ToolchainName = 'SDCC' | 'Keil_C51' | 'AC5' | 'AC6' | 'GCC' | 'IAR_STM8' | 'GNU_SDCC_STM8' | 'RISCV_GCC' | 'None';

export interface IProjectInfo {

    readonly targetName: string;

    toAbsolutePath: (path: string) => string;

    getOutDir: () => string;
}

export interface IToolchian {

    readonly name: ToolchainName;

    readonly categoryName: string;

    readonly modelName: string;

    readonly configName: string;

    readonly settingName: string;

    readonly verifyFileName: string;

    readonly excludeViewList?: string[];

    readonly version: number;

    getToolchainDir(): File;

    getGccCompilerPath(): string | undefined;

    getGccCompilerCmdArgsForIntelliSense(): string[] | undefined;

    getInternalDefines(builderOpts: ICompileOptions): string[];

    getCustomDefines(): string[] | undefined;

    getSystemIncludeList(builderOpts: ICompileOptions): string[];

    getDefaultIncludeList(): string[];

    getForceIncludeHeaders(): string[] | undefined;

    getLibDirs(): string[];

    preHandleOptions(prjInfo: IProjectInfo, options: ICompileOptions): void;

    getDefaultConfig(): ICompileOptions;

    newInstance(): IToolchian;
}

let _instance: ToolchainManager;

interface ToolchainEnums {
    [type: string]: ToolchainName[];
}

export class ToolchainManager {

    private readonly toolchainNames: ToolchainEnums = {
        'C51': ['Keil_C51', 'SDCC', 'IAR_STM8'/*, 'GNU_SDCC_STM8'*/],
        'ARM': ['AC5', 'AC6', 'GCC'],
        'RISC-V': ['RISCV_GCC']
    };

    private toolchainMap: Map<ToolchainName, IToolchian>;
    private _event: events.EventEmitter;

    private constructor() {
        this._event = new events.EventEmitter();
        this.toolchainMap = new Map();

        // reload after setting changed
        SettingManager.GetInstance().on('onChanged', (e) => {
            for (const toolchain of this.toolchainMap.values()) {
                if (e.affectsConfiguration(toolchain.settingName)) {
                    this.add(toolchain.newInstance());
                    this.emit('onChanged', toolchain.name);
                }
            }
        });

        // register toolchain
        this.add(new KeilC51());
        this.add(new SDCC());
        this.add(new AC5());
        this.add(new AC6());
        this.add(new GCC());
        this.add(new IARSTM8());
        this.add(new RISCV_GCC());
        //this.add(new GnuStm8Sdcc());
    }

    on(event: 'onChanged', listener: (toolchainName: ToolchainName) => void): void;
    on(event: string | symbol, listener: (arg?: any) => void): void {
        this._event.on(event, listener);
    }

    private emit(event: 'onChanged', toolchainName: ToolchainName): boolean;
    private emit(event: string | symbol, arg?: any): boolean {
        return this._event.emit(event, arg);
    }

    static getInstance(): ToolchainManager {
        if (_instance === undefined) { _instance = new ToolchainManager(); }
        return _instance;
    }

    getToolchain(prjType: ProjectType, toolchainName: ToolchainName): IToolchian {

        let res: IToolchian | undefined;

        switch (prjType) {
            case 'RISC-V':
                res = this.toolchainMap.get('RISCV_GCC');
                break;
            case 'ARM':
                switch (toolchainName) {
                    case 'None':
                        res = this.toolchainMap.get('AC5');
                        break;
                    default:
                        if (this.toolchainNames['ARM'].includes(toolchainName)) {
                            res = this.toolchainMap.get(toolchainName);
                        } else {
                            res = this.toolchainMap.get('AC5');
                            GlobalEvent.emit('msg', newMessage('Warning',
                                'Invalid toolchain name \'' + toolchainName + '\' !, use default toolchain.'));
                        }
                }
                break;
            case 'C51':
                switch (toolchainName) {
                    case 'None':
                        res = this.toolchainMap.get('Keil_C51');
                        break;
                    default:
                        if (this.toolchainNames['C51'].includes(toolchainName)) {
                            res = this.toolchainMap.get(toolchainName);
                        }
                        else {
                            res = this.toolchainMap.get('Keil_C51');
                            GlobalEvent.emit('msg', newMessage('Warning',
                                'Invalid toolchain name \'' + toolchainName + '\' !, use default toolchain.'));
                        }
                }
                break;
            default:
                throw new Error('Invalid project type \'' + prjType + '\'');
        }

        if (res === undefined) {
            throw new Error('Not found toolchain \'' + toolchainName + '\' for \'' + prjType + '\'');
        }

        return res;
    }

    getToolchainByName(name: ToolchainName): IToolchian | undefined {
        return this.toolchainMap.get(name);
    }

    getToolchainNameList(prjType: ProjectType): ToolchainName[] {
        return this.toolchainNames[prjType];
    }

    getToolchainDesc(name: ToolchainName): string {
        switch (name) {
            case 'AC5':
                return 'ARM C Compiler Version 5';
            case 'AC6':
                return 'ARM C Compiler Version 6';
            case 'Keil_C51':
                return 'Keil C51 Compiler';
            case 'SDCC':
                return 'Small Device C Compiler';
            case 'GCC':
                return 'GNU Arm Embedded Toolchain';
            case 'IAR_STM8':
                return 'IAR C Compiler for STM8';
            case 'GNU_SDCC_STM8':
                return 'SDCC With GNU Patch For STM8';
            case 'RISCV_GCC':
                return 'GCC for RISC-V';
            default:
                return '';
        }
    }

    updateToolchainConfig(configFile: File, toolchain: IToolchian): void {
        try {
            // if exist
            if (configFile.IsFile()) {

                const optionObj: ICompileOptions = JSON.parse(configFile.Read());
                const oldVersion: number = optionObj.version || 0;

                // if obsoleted, update it
                if (toolchain.version > oldVersion) {
                    const defOptions: ICompileOptions = toolchain.getDefaultConfig();

                    // update version
                    optionObj.version = defOptions.version;

                    const updateList = ['global', 'c/cpp-compiler', 'asm-compiler', 'linker'];
                    const properFile = File.fromArray([ResManager.GetInstance().getLangDir().path, toolchain.verifyFileName]);
                    const properties = JSON.parse(properFile.Read())['properties'];

                    // compatible some linker old params
                    if (optionObj.linker) {
                        // sdcc
                        if (toolchain.name === 'SDCC' && optionObj.linker['executable-format']) {
                            defOptions.linker['output-format'] = optionObj.linker['executable-format'];
                        }
                        // all
                        if (optionObj.linker['output-lib']) {
                            defOptions.linker['output-format'] = 'lib';
                        }
                    }

                    // compatible some c/cpp-compiler old params
                    if (optionObj['c/cpp-compiler']) {
                        // armcc5
                        if (toolchain.name === 'AC5' && optionObj['c/cpp-compiler']['misc-control']) {
                            if (optionObj['c/cpp-compiler']['C_FLAGS']) {
                                optionObj['c/cpp-compiler']['C_FLAGS'] =
                                    optionObj['c/cpp-compiler']['misc-control'] + ' ' + optionObj['c/cpp-compiler']['C_FLAGS'];
                            } else {
                                optionObj['c/cpp-compiler']['C_FLAGS'] = optionObj['c/cpp-compiler']['misc-control'];
                            }
                        }
                    }

                    // iar stm8 code-mode, data-mode
                    if (optionObj["c/cpp-compiler"] && toolchain.name === 'IAR_STM8') {
                        defOptions.global['code-mode'] = optionObj["c/cpp-compiler"]['code-mode'] || defOptions.global['code-mode'];
                        defOptions.global['data-mode'] = optionObj["c/cpp-compiler"]['data-mode'] || defOptions.global['data-mode'];
                    }

                    // clear invalid properties
                    for (const name of updateList) {
                        if (properties[name]) {
                            const propertyFields = properties[name]['properties'];
                            const currentObj = (<any>optionObj)[name];
                            if (currentObj) {
                                for (const field in currentObj) {
                                    if (propertyFields[field] === undefined) { // if not have this property, clear it
                                        currentObj[field] = undefined;
                                    }
                                }
                            }
                        }
                    }

                    // update null properties
                    for (const name of updateList) {
                        const currentObj = (<any>optionObj)[name];
                        const defObj = (<any>defOptions)[name];
                        if (defObj) { // if default object is valid
                            if (currentObj) {
                                for (const key in defObj) {
                                    if (currentObj[key] === undefined) {
                                        currentObj[key] = defObj[key];
                                    }
                                }
                            } else {
                                (<any>optionObj)[name] = defObj;
                            }
                        }
                    }

                    // write to file
                    configFile.Write(JSON.stringify(optionObj, undefined, 4));
                }
            } else {
                // write default config to file
                configFile.Write(JSON.stringify(toolchain.getDefaultConfig(), undefined, 4));
            }
        } catch (error) {
            GlobalEvent.emit('msg', ExceptionToMessage(error, 'Hidden'));
        }
    }

    isToolchainPathReady(name: ToolchainName): boolean {

        const settingManager = SettingManager.GetInstance();

        switch (name) {
            case 'AC5':
                return File.fromArray([settingManager.getArmcc5Dir().path, 'bin']).IsDir();
            case 'AC6':
                return File.fromArray([settingManager.getArmcc6Dir().path, 'bin']).IsDir();
            case 'Keil_C51':
                return settingManager.isKeilC51IniReady();
            case 'GCC':
                return File.fromArray([settingManager.getGCCDir().path, 'bin']).IsDir();
            case 'IAR_STM8':
                return File.fromArray([settingManager.getIARForStm8Dir().path, 'stm8', 'bin']).IsDir();
            case 'SDCC':
                return File.fromArray([settingManager.getSdccDir().path, 'bin']).IsDir();
            case 'RISCV_GCC':
                return File.fromArray([settingManager.getRiscvToolFolder().path, 'bin']).IsDir();
            case 'GNU_SDCC_STM8':
                return File.fromArray([settingManager.getGnuSdccStm8Dir().path, 'bin']).IsDir();
            default:
                return false;
        }
    }

    //----------------------

    private add(toolchain: IToolchian) {
        this.toolchainMap.set(toolchain.name, toolchain);
    }
}

class MacroHandler {

    private regMatchers = {
        'normal_macro': /^#define (\w+) (.*)$/,
        'func_macro': /^#define (\w+\([^\)]*\)) (.*)$/
    };

    toExpression(macro: string): string | undefined {

        let mList = this.regMatchers['normal_macro'].exec(macro);
        if (mList && mList.length > 2) {
            return `${mList[1]}=${mList[2]}`;
        }

        mList = this.regMatchers['func_macro'].exec(macro);
        if (mList && mList.length > 2) {
            return `${mList[1]}=`;
        }
    }
}

//=======================================================

class KeilC51 implements IToolchian {

    readonly version = 2;

    readonly settingName: string = 'EIDE.C51.INI.Path';

    readonly verifyFileName: string = '8051.keil.verify.json';

    readonly categoryName: string = 'C51';

    readonly name: ToolchainName = 'Keil_C51';

    readonly modelName: string = '8051.keil.model.json';

    readonly configName: string = '8051.options.keil.json';

    getForceIncludeHeaders(): string[] | undefined {
        return [
            ResManager.GetInstance().getC51ForceIncludeHeaders().path
        ];
    }

    newInstance(): IToolchian {
        return new KeilC51();
    }

    getGccCompilerPath(): string | undefined {
        const gcc = File.fromArray([this.getToolchainDir().path, 'BIN', 'C51.exe']);
        return gcc.path;
    }

    getGccCompilerCmdArgsForIntelliSense(): string[] | undefined {
        return undefined;
    }

    preHandleOptions(prjInfo: IProjectInfo, c51Options: ICompileOptions): void {

        // convert optimization
        if (c51Options["c/cpp-compiler"]) {
            const opType = (<string>c51Options["c/cpp-compiler"]['optimization-type'])?.toUpperCase() || 'SPEED';
            const opLevel = (<string>c51Options["c/cpp-compiler"]['optimization-level'])?.replace('level-', '') || '8';
            c51Options["c/cpp-compiler"]['optimization'] = opLevel + ',' + opType;
        }

        // convert warnings number
        if (c51Options["linker"]) {
            const warnings = (<string[] | undefined>c51Options["linker"]['disable-warnings']);
            if (warnings) {
                c51Options["linker"]['disable-warnings'] = warnings.join(',');
            }
        }

        // convert output lib commmand
        if (c51Options['linker'] && c51Options['linker']['output-format'] === 'lib') {

            // set options
            c51Options['linker']['$use'] = 'linker-lib';

            // create empty lib
            const libFile = new File(prjInfo.getOutDir() + File.sep + prjInfo.targetName + '.LIB');
            if (libFile.IsFile()) {
                try {
                    fs.unlinkSync(libFile.path);
                } catch (error) {
                    GlobalEvent.emit('msg', ExceptionToMessage(error, 'Hidden'));
                    throw new Error('Delete exist lib failed !, [path]: ' + libFile.path);
                }
            }

            const tmpLib = File.fromArray([ResManager.GetInstance().GetTemplateDir().path, 'C51.LIB']);
            if (!tmpLib.IsFile()) {
                throw new Error('Not found template LIB !, [path]: ' + tmpLib.path);
            }

            try {
                fs.copyFileSync(tmpLib.path, libFile.path);
            } catch (error) {
                GlobalEvent.emit('msg', ExceptionToMessage(error, 'Hidden'));
                throw new Error('Create empty C51 LIB failed !');
            }
        }
    }

    getInternalDefines(builderOpts: ICompileOptions): string[] {
        return [];
    }

    getCustomDefines(): string[] | undefined {
        return [
            '__UVISION_VERSION=526' /* this is a placeholder !, don't delete it !*/
        ];
    }

    getToolchainDir(): File {
        return SettingManager.GetInstance().GetC51Dir();
    }

    getSystemIncludeList(builderOpts: ICompileOptions): string[] {
        return [];
    }

    getDefaultIncludeList(): string[] {
        return [
            File.fromArray([this.getToolchainDir().path, 'INC']).path
        ];
    }

    getLibDirs(): string[] {
        return [File.fromArray([this.getToolchainDir().path, 'LIB']).path];
    }

    getDefaultConfig(): ICompileOptions {
        return <ICompileOptions>{
            version: this.version,
            beforeBuildTasks: [],
            afterBuildTasks: [],
            global: {
                "ram-mode": "SMALL",
                "rom-mode": "LARGE"
            },
            'c/cpp-compiler': {
                "optimization-type": "SPEED",
                "optimization-level": "level-8"
            },
            'asm-compiler': {},
            linker: {
                "remove-unused": true,
                "output-format": "elf"
            }
        };
    }
}

class SDCC implements IToolchian {

    readonly version = 3;

    readonly settingName: string = 'EIDE.SDCC.InstallDirectory';

    readonly categoryName: string = 'SDCC';

    readonly name: ToolchainName = 'SDCC';

    readonly modelName: string = 'sdcc.model.json';

    readonly configName: string = 'options.sdcc.json';

    readonly verifyFileName: string = 'sdcc.verify.json';

    private readonly asmMapper: any = {
        "mcs51": "8051",
        "ds400": "ds390",
        "hc08": "6808",
        "s08": "6808",
        "r2k": "rab",
        "gbz80": "gb",
        "ez80_z80": "z80"
    };

    newInstance(): IToolchian {
        return new SDCC();
    }

    getGccCompilerPath(): string | undefined {
        const gcc = File.fromArray([this.getToolchainDir().path, 'bin', 'sdcc.exe']);
        return gcc.path;
    }

    getGccCompilerCmdArgsForIntelliSense(): string[] | undefined {
        return undefined;
    }

    preHandleOptions(prjInfo: IProjectInfo, options: ICompileOptions): void {

        /* init default */
        if (options["linker"] == undefined) { options["linker"] = {} }
        if (options["asm-compiler"] == undefined) { options["asm-compiler"] = {} }

        /* convert output format */
        if (options['linker']['output-format']) {
            switch (options['linker']['output-format']) {
                case 'lib':
                    options['linker']['$use'] = 'linker-lib';
                    break;
                case 'hex':
                    options['linker']['$use'] = undefined; // hex format
                    break;
                default:
                    options['linker']['$use'] = options['linker']['output-format'];
                    break;
            }
        }

        /* set assembler for sdcc */
        const devName = options.global?.['device'] || 'mcs51';
        const asmName = `sdas${this.asmMapper[devName] || devName}`;
        options["asm-compiler"]['$toolName'] = asmName;
    }

    private parseCodeModel(conf: string): string | undefined {
        const mType = /\s*--model-(\w+)\s*/i.exec(conf);
        if (mType && mType.length > 1) {
            return mType[1];
        }
    }

    private parseProcessor(conf: string): string | undefined {
        const res = /\s*-p(\w+)\s*/i.exec(conf);
        if (res && res.length > 1) {
            return res[1];
        }
    }

    getInternalDefines(builderOpts: ICompileOptions): string[] {

        const mList: string[] = [
            '__SDCC',
            `__SDCC_VERSION_MAJOR=4`,
            `__SDCC_VERSION_MINOR=1`,
            `__SDCC_VERSION_PATCH=0`
        ];

        // code model
        let devName: string = 'mcs51';
        let codeModel: string | undefined;
        let processor: string | undefined;

        // global config
        if (builderOpts.global) {
            const conf = builderOpts.global;

            // get device name
            if (conf['device']) {
                devName = conf['device'];
                mList.push(`__SDCC_${devName}`);
            }

            // get model type
            if (conf['misc-controls']) {
                codeModel = this.parseCodeModel(conf['misc-controls']);
                processor = this.parseProcessor(conf['misc-controls']);
            }

            // is use stack auto 
            if (conf['stack-auto']) {
                mList.push(`__SDCC_STACK_AUTO`);
            }

            // is use xstack 
            if (conf['use-external-stack']) {
                mList.push(`__SDCC_USE_XSTACK`);
            }

            // int long reent
            if (conf['int-long-reent']) {
                mList.push(`__SDCC_INT_LONG_REENT`);
            }

            // float reent
            if (conf['float-reent']) {
                mList.push(`__SDCC_FLOAT_REENT`);
            }
        }

        // cpp config
        if (builderOpts["c/cpp-compiler"]) {
            const conf = builderOpts["c/cpp-compiler"];
            // get model type
            if (conf['misc-controls']) {
                codeModel = this.parseCodeModel(conf['misc-controls']) || codeModel;
            }
        }

        // set processor
        if (processor) {
            // for pic processor
            if (devName.startsWith('pic')) {
                mList.push(`__SDCC_PIC${processor.toUpperCase()}`);
            }
        }

        if (devName == 'ds390') { // set ds390 model
            mList.push(`__SDCC_MODEL_FLAT24`);
        } else if (codeModel) { // set code model
            mList.push(`__SDCC_MODEL_${codeModel.toUpperCase()}`);
        }

        return mList;
    }

    getCustomDefines(): string[] | undefined {
        return undefined;
    }

    getToolchainDir(): File {
        return SettingManager.GetInstance().getSdccDir();
    }

    getSystemIncludeList(builderOpts: ICompileOptions): string[] {

        const toolchainDir: string = this.getToolchainDir().path;
        const incList: string[] = [File.fromArray([toolchainDir, 'include']).path];

        let devName: string = 'mcs51';

        if (builderOpts.global) {
            const conf = builderOpts.global;

            // get device name
            if (conf['device']) {
                devName = conf['device'];
                const devInc = File.fromArray([toolchainDir, 'include', devName]);
                if (devInc.IsDir()) {
                    incList.push(devInc.path);
                }
            }

            // is use non-free libs
            if (conf['use-non-free']) {
                incList.push(File.fromArray([toolchainDir, 'non-free', 'include']).path);
                const devInc = File.fromArray([toolchainDir, 'non-free', 'include', devName]);
                if (devInc.IsDir()) {
                    incList.push(devInc.path);
                }
            }
        }

        return incList;
    }

    getForceIncludeHeaders(): string[] | undefined {
        return [
            ResManager.GetInstance().getC51ForceIncludeHeaders().path
        ];
    }

    getDefaultIncludeList(): string[] {
        return [];
    }

    getLibDirs(): string[] {
        return [File.fromArray([this.getToolchainDir().path, 'lib']).path];
    }

    getDefaultConfig(): ICompileOptions {
        return <ICompileOptions>{
            version: this.version,
            beforeBuildTasks: [],
            afterBuildTasks: [],
            global: {
                "device": "mcs51",
                "optimize-type": "speed",
                "use-non-free": false
            },
            'c/cpp-compiler': {
                "language-c": "c99"
            },
            'asm-compiler': {},
            linker: {
                "$mainFileName": "main",
                "output-format": "hex"
            }
        };
    }
}

class GnuStm8Sdcc implements IToolchian {

    readonly version = 1;

    readonly settingName: string = 'EIDE.STM8.GNU-SDCC.InstallDirectory';

    readonly categoryName: string = 'SDCC';

    readonly name: ToolchainName = 'GNU_SDCC_STM8';

    readonly modelName: string = 'stm8.gnu-sdcc.model.json';

    readonly configName: string = 'options.stm8.gnu-sdcc.json';

    readonly verifyFileName: string = 'stm8.gnu-sdcc.verify.json';

    newInstance(): IToolchian {
        return new SDCC();
    }

    getGccCompilerPath(): string | undefined {
        const gcc = File.fromArray([this.getToolchainDir().path, 'bin', 'sdcc.exe']);
        return gcc.path;
    }

    getGccCompilerCmdArgsForIntelliSense(): string[] | undefined {
        return undefined;
    }

    preHandleOptions(prjInfo: IProjectInfo, options: ICompileOptions): void {

        if (options['linker'] == undefined) {
            options['linker'] = {};
        }

        // convert output lib commmand
        if (options['linker']['output-format'] === 'lib') {
            options['linker']['$use'] = 'linker-lib';
        }

        // get code model
        let codeModel: string = 'medium';
        if (options["c/cpp-compiler"]) {
            const conf = options["c/cpp-compiler"];
            if (conf['misc-controls']) { // get model type
                codeModel = this.parseCodeModel(conf['misc-controls']) || codeModel;
            }
        }

        /* append def linker params */
        {
            const ldFlags: string[] = [];
            const libFlags: string[] = [];

            if (options['linker']['misc-controls']) {
                ldFlags.push(options['linker']['misc-controls']);
            }

            if (options['linker']['LIB_FLAGS']) {
                libFlags.push(options['linker']['LIB_FLAGS']);
            }

            // append default lib search path
            const libDir = File.ToUnixPath(this.getToolchainDir().path + File.sep + `lib-${codeModel}`);
            ldFlags.push(`-L"${libDir}"`);

            // append default system lib
            libFlags.push('-lstm8');

            // set flags
            options['linker']['misc-controls'] = ldFlags.join(' ');
            options['linker']['LIB_FLAGS'] = libFlags.join(' ');
        }
    }

    private parseCodeModel(conf: string): string | undefined {
        const mType = /\s*--model-(\w+)\s*/i.exec(conf);
        if (mType && mType.length > 1) {
            return mType[1];
        }
    }

    getInternalDefines(builderOpts: ICompileOptions): string[] {

        const mList: string[] = [
            '__SDCC',
            `__SDCC_VERSION_MAJOR=3`,
            `__SDCC_VERSION_MINOR=9`,
            `__SDCC_VERSION_PATCH=3`
        ];

        // code model
        let devName: string = 'stm8';
        let codeModel: string = 'medium';

        // fix device name: stm8
        mList.push(`__SDCC_${devName}`);

        // global config
        if (builderOpts["c/cpp-compiler"]) {

            const conf = builderOpts["c/cpp-compiler"];

            // get model type
            if (conf['misc-controls']) {
                codeModel = this.parseCodeModel(conf['misc-controls']) || codeModel;
            }

            // is use stack auto 
            if (conf['stack-auto']) {
                mList.push(`__SDCC_STACK_AUTO`);
            }

            // is use xstack 
            if (conf['use-external-stack']) {
                mList.push(`__SDCC_USE_XSTACK`);
            }

            // int long reent
            if (conf['int-long-reent']) {
                mList.push(`__SDCC_INT_LONG_REENT`);
            }

            // float reent
            if (conf['float-reent']) {
                mList.push(`__SDCC_FLOAT_REENT`);
            }
        }

        if (codeModel) { // set code model
            mList.push(`__SDCC_MODEL_${codeModel.toUpperCase()}`);
        }

        return mList;
    }

    getCustomDefines(): string[] | undefined {
        return undefined;
    }

    getToolchainDir(): File {
        return SettingManager.GetInstance().getGnuSdccStm8Dir();
    }

    getSystemIncludeList(builderOpts: ICompileOptions): string[] {

        const toolchainDir: string = this.getToolchainDir().path;
        const incList: string[] = [File.fromArray([toolchainDir, 'include']).path];

        // get device name include
        const devInc = File.fromArray([toolchainDir, 'include', 'stm8']);
        if (devInc.IsDir()) {
            incList.push(devInc.path);
        }

        return incList;
    }

    getForceIncludeHeaders(): string[] | undefined {
        return [
            ResManager.GetInstance().getC51ForceIncludeHeaders().path
        ];
    }

    getDefaultIncludeList(): string[] {
        return [];
    }

    getLibDirs(): string[] {
        return [];
    }

    getDefaultConfig(): ICompileOptions {
        return <ICompileOptions>{
            version: this.version,
            beforeBuildTasks: [],
            afterBuildTasks: [],
            global: {
                "out-debug-info": false
            },
            'c/cpp-compiler': {
                "language-c": "c99",
                "optimize-type": "speed",
                "one-elf-section-per-function": true,
                "one-elf-section-per-data": false
            },
            'asm-compiler': {},
            linker: {
                "output-format": "elf",
                "remove-unused-sections": true
            }
        };
    }
}

class AC5 implements IToolchian {

    readonly version = 4;

    readonly settingName: string = 'EIDE.ARM.ARMCC5.InstallDirectory';

    readonly categoryName: string = 'ARMCC';

    readonly name: ToolchainName = 'AC5';

    readonly modelName: string = 'arm.v5.model.json';

    readonly configName: string = 'arm.options.v5.json';

    readonly verifyFileName: string = 'arm.v5.verify.json';

    newInstance(): IToolchian {
        return new AC5();
    }

    getGccCompilerPath(): string | undefined {
        const armccFile = File.fromArray([this.getToolchainDir().path, 'bin', 'armcc.exe']);
        return armccFile.path;
    }

    getGccCompilerCmdArgsForIntelliSense(): string[] | undefined {
        return undefined;
    }

    preHandleOptions(prjInfo: IProjectInfo, options: ICompileOptions): void {
        // convert output lib commmand
        if (options['linker'] && options['linker']['output-format'] === 'lib') {
            options['linker']['$use'] = 'linker-lib';
        }
    }

    getToolchainDir(): File {
        return SettingManager.GetInstance().getArmcc5Dir();
    }

    getForceIncludeHeaders(): string[] {
        return [
            ResManager.GetInstance().getArmccForceIncludeHeaders().path
        ];
    }

    getInternalDefines(builderOpts: ICompileOptions): string[] {
        return [];
    }

    getCustomDefines(): string[] | undefined {
        return undefined;
    }

    getSystemIncludeList(builderOpts: ICompileOptions): string[] {
        const incDir = File.fromArray([this.getToolchainDir().path, 'include']);
        if (incDir.IsDir()) {
            return [incDir].concat(incDir.GetList(File.EMPTY_FILTER)).map((f) => { return f.path; });
        }
        return [incDir.path];
    }

    getDefaultIncludeList(): string[] {
        return [];
    }

    getLibDirs(): string[] {
        return [File.fromArray([this.getToolchainDir().path, 'lib']).path];
    }

    getDefaultConfig(): ICompileOptions {
        return <ICompileOptions>{
            version: this.version,
            beforeBuildTasks: [],
            afterBuildTasks: [],
            global: {
                "use-microLIB": true,
                "output-debug-info": "enable"
            },
            'c/cpp-compiler': {
                "optimization": "level-0",
                "one-elf-section-per-function": true,
                "c99-mode": true,
                "C_FLAGS": "--diag_suppress=1 --diag_suppress=1295",
                "CXX_FLAGS": "--diag_suppress=1 --diag_suppress=1295"
            },
            'asm-compiler': {},
            linker: {
                "output-format": 'elf'
            }
        };
    }
}

class AC6 implements IToolchian {

    readonly version = 3;

    readonly settingName: string = 'EIDE.ARM.ARMCC6.InstallDirectory';

    readonly categoryName: string = 'ARMCC';

    readonly name: ToolchainName = 'AC6';

    readonly modelName: string = 'arm.v6.model.json';

    readonly configName: string = 'arm.options.v6.json';

    readonly verifyFileName: string = 'arm.v6.verify.json';

    /*
    private readonly defMacroList: string[];

    constructor() {
        const armClang = File.fromArray([this.getToolchainDir().path, 'bin', 'armclang.exe']);
        this.defMacroList = this.getMacroList(armClang.path);
    }

    private getMacroList(armClangPath: string): string[] {
        try {
            const cmdLine = CmdLineHandler.quoteString(armClangPath, '"')
                + ' ' + ['--target=arm-arm-none-eabi', '-E', '-dM', '-', '<nul'].join(' ');

            const lines = child_process.execSync(cmdLine).toString().split(/\r\n|\n/);
            const resList: string[] = [];
            const mHandler = new MacroHandler();

            lines.filter((line) => { return line.trim() !== ''; })
                .forEach((line) => {
                    const value = mHandler.toExpression(line);
                    if (value) {
                        resList.push(value);
                    }
                });

            return resList;
        } catch (error) {
            GlobalEvent.emit('msg', ExceptionToMessage(error, 'Hidden'));
            return ['__GNUC__=4', '__GNUC_MINOR__=2', '__GNUC_PATCHLEVEL__=1'];
        }
    }
    */

    newInstance(): IToolchian {
        return new AC6();
    }

    getGccCompilerPath(): string | undefined {
        const armccFile = File.fromArray([this.getToolchainDir().path, 'bin', 'armclang.exe']);
        return armccFile.path;
    }

    getGccCompilerCmdArgsForIntelliSense(): string[] | undefined {
        return ['--target=arm-arm-none-eabi'];
    }

    preHandleOptions(prjInfo: IProjectInfo, options: ICompileOptions): void {

        if (options['linker'] === undefined) {
            options['linker'] = Object.create(null);
        }

        // convert output lib commmand
        if (options['linker']['output-format'] === 'lib') {
            options['linker']['$use'] = 'linker-lib';
        }

        // set link time optimization
        if (options['c/cpp-compiler'] && options['c/cpp-compiler']['link-time-optimization']) {
            options['linker']['link-time-optimization'] = options['c/cpp-compiler']['link-time-optimization'];
        }
    }

    getToolchainDir(): File {
        return SettingManager.GetInstance().getArmcc6Dir();
    }

    getInternalDefines(builderOpts: ICompileOptions): string[] {
        return [];
    }

    getCustomDefines(): string[] | undefined {
        return undefined;
    }

    getSystemIncludeList(builderOpts: ICompileOptions): string[] {
        return [
            File.fromArray([this.getToolchainDir().path, 'include']).path,
            File.fromArray([this.getToolchainDir().path, 'include', 'libcxx']).path
        ];
    }

    getForceIncludeHeaders(): string[] | undefined {
        return [
            ResManager.GetInstance().getArmclangForceIncludeHeaders().path
        ];
    }

    getDefaultIncludeList(): string[] {
        return [];
    }

    getLibDirs(): string[] {
        return [File.fromArray([this.getToolchainDir().path, 'lib']).path];
    }

    getDefaultConfig(): ICompileOptions {
        return <ICompileOptions>{
            version: this.version,
            beforeBuildTasks: [],
            afterBuildTasks: [],
            global: {
                "use-microLIB": true,
                "output-debug-info": "enable"
            },
            'c/cpp-compiler': {
                "optimization": "level-0",
                "language-c": "c99",
                "language-cpp": "c++11",
                "link-time-optimization": true
            },
            'asm-compiler': {},
            linker: {
                "output-format": 'elf',
                'misc-controls': '--diag_suppress=L6329'
            }
        };
    }
}

class GCC implements IToolchian {

    readonly version = 4;

    readonly settingName: string = 'EIDE.ARM.GCC.InstallDirectory';

    readonly categoryName: string = 'GCC';

    readonly name: ToolchainName = 'GCC';

    readonly modelName: string = 'arm.gcc.model.json';

    readonly configName: string = 'arm.options.gcc.json';

    readonly verifyFileName: string = 'arm.gcc.verify.json';

    private readonly defMacroList: string[];

    //---

    private incList: string[];

    constructor() {
        const gcc = File.fromArray([this.getToolchainDir().path, 'bin', this.getToolPrefix() + 'gcc.exe']);
        this.defMacroList = this.getMacroList(gcc.path);
        this.incList = this.getIncludeList(gcc.path);
    }

    private getIncludeList(gccPath: string): string[] {
        try {
            const cmdLine = CmdLineHandler.quoteString(gccPath, '"')
                + ' ' + ['-xc++', '-E', '-v', '-', '<nul 2>&1'].join(' ');
            const lines = child_process.execSync(cmdLine).toString().split(/\r\n|\n/);
            const iStart = lines.findIndex((line) => { return line.startsWith('#include <...>'); });
            const iEnd = lines.indexOf('End of search list.', iStart);
            return lines.slice(iStart + 1, iEnd)
                .map((line) => { return new File(File.ToLocalPath(line.trim())); })
                .filter((file) => { return file.IsDir(); })
                .map((f) => {
                    return f.path;
                });
        } catch (error) {
            GlobalEvent.emit('msg', ExceptionToMessage(error, 'Hidden'));
            return [];
        }
    }

    private getMacroList(gccPath: string): string[] {
        try {
            const cmdLine = CmdLineHandler.quoteString(gccPath, '"')
                + ' ' + ['-E', '-dM', '-', '<nul'].join(' ');

            const lines = child_process.execSync(cmdLine).toString().split(/\r\n|\n/);
            const results: string[] = [];
            const mHandler = new MacroHandler();

            lines.filter((line) => { return line.trim() !== ''; })
                .forEach((line) => {
                    const value = mHandler.toExpression(line);
                    if (value) {
                        results.push(value);
                    }
                });

            return results;
        } catch (error) {
            GlobalEvent.emit('msg', ExceptionToMessage(error, 'Hidden'));
            return ['__GNUC__=8', '__GNUC_MINOR__=3', '__GNUC_PATCHLEVEL__=1'];
        }
    }

    private getToolPrefix(): string {
        return SettingManager.GetInstance().getGCCPrefix();
    }

    //-----------

    newInstance(): IToolchian {
        return new GCC();
    }

    getGccCompilerPath(): string | undefined {
        const gcc = File.fromArray([this.getToolchainDir().path, 'bin', this.getToolPrefix() + 'gcc.exe']);
        return gcc.path;
    }

    getGccCompilerCmdArgsForIntelliSense(): string[] | undefined {
        return undefined;
    }

    preHandleOptions(prjInfo: IProjectInfo, options: ICompileOptions): void {

        // convert output lib commmand
        if (options['linker'] && options['linker']['output-format'] === 'lib') {
            options['linker']['$use'] = 'linker-lib';
        }

        // if region 'global' is not exist, create it
        if (typeof options['global'] !== 'object') {
            options['global'] = {};
        }

        // set tool prefix
        options['global'].toolPrefix = SettingManager.GetInstance().getGCCPrefix();
    }

    getInternalDefines(builderOpts: ICompileOptions): string[] {
        return this.defMacroList;
    }

    getCustomDefines(): string[] | undefined {
        return undefined;
    }

    getToolchainDir(): File {
        return SettingManager.GetInstance().getGCCDir();
    }

    getSystemIncludeList(builderOpts: ICompileOptions): string[] {
        return Array.from(this.incList);
    }

    getForceIncludeHeaders(): string[] | undefined {
        return [
            ResManager.GetInstance().getGccForceIncludeHeaders().path
        ];
    }

    getDefaultIncludeList(): string[] {
        return [];
    }

    getLibDirs(): string[] {
        return [];
    }

    getDefaultConfig(): ICompileOptions {
        return <ICompileOptions>{
            version: this.version,
            beforeBuildTasks: [],
            afterBuildTasks: [],
            global: {
                "$float-abi-type": 'softfp',
                "output-debug-info": 'enable'
            },
            'c/cpp-compiler': {
                "language-c": "c11",
                "language-cpp": "c++11",
                "optimization": 'level-debug',
                "warnings": "all-warnings",
                "C_FLAGS": "-ffunction-sections -fdata-sections",
                "CXX_FLAGS": "-ffunction-sections -fdata-sections"
            },
            'asm-compiler': {
                "ASM_FLAGS": "-ffunction-sections -fdata-sections"
            },
            linker: {
                "output-format": "elf",
                "LD_FLAGS": "--specs=nosys.specs --specs=nano.specs -Wl,--gc-sections",
                "LIB_FLAGS": "-lm"
            }
        };
    }
}

class IARSTM8 implements IToolchian {

    readonly version = 5;

    readonly name: ToolchainName = 'IAR_STM8';

    readonly categoryName: string = 'IAR';

    readonly modelName: string = 'stm8.iar.model.json';

    readonly configName: string = 'options.stm8.iar.json';

    readonly settingName: string = 'EIDE.IAR.STM8.InstallDirectory';

    readonly verifyFileName: string = 'stm8.iar.verify.json';

    newInstance(): IToolchian {
        return new IARSTM8();
    }

    getGccCompilerPath(): string | undefined {
        const gcc = File.fromArray([this.getToolchainDir().path, 'stm8', 'bin', 'iccstm8.exe']);
        return gcc.path;
    }
    
    getGccCompilerCmdArgsForIntelliSense(): string[] | undefined {
        return undefined;
    }

    preHandleOptions(prjInfo: IProjectInfo, options: ICompileOptions): void {

        // init null options
        for (const key of ['linker', 'c/cpp-compiler']) {
            if ((<any>options)[key] === undefined) {
                (<any>options)[key] = Object.create(null);
            }
        }

        // convert output lib commmand
        if (options['linker']['output-format'] === 'lib') {
            options['linker']['$use'] = 'linker-lib';
        }

        // set linker path
        const linkerConfig: string | undefined = options.linker['linker-config'];
        if (linkerConfig) {

            // path is relative by project root folder
            if (linkerConfig.startsWith('./') || linkerConfig.startsWith('.\\')) {
                options.linker['linker-config'] = `"${prjInfo.toAbsolutePath(options.linker['linker-config'])}"`;
            }

            // use toolchain root folder, like ${ToolchainRoot}\stm8\config
            else if (linkerConfig.toLowerCase().startsWith('${ToolchainRoot}')) {
                const absPath = (<string>options.linker['linker-config']).replace(/\$\{ToolchainRoot\}/i, this.getToolchainDir().path);
                options.linker['linker-config'] = `"${NodePath.normalize(absPath)}"`;
            }
        }

        // set runtime-lib
        const rtLibtype: string | undefined = options["c/cpp-compiler"]['runtime-lib'];
        if (rtLibtype && rtLibtype !== 'null') {
            const mCode: string = (<string>options["c/cpp-compiler"]['code-mode'] || 'small').charAt(0);
            const mData: string = (<string>options["c/cpp-compiler"]['data-mode'] || 'medium').charAt(0);
            const type: string = rtLibtype.charAt(0);
            options["c/cpp-compiler"]['runtime-lib'] = `dlstm8${mCode}${mData}${type}.h`;
        } else {
            options["c/cpp-compiler"]['runtime-lib'] = undefined;
        }
    }

    getToolchainDir(): File {
        return SettingManager.GetInstance().getIARForStm8Dir();
    }

    getInternalDefines(builderOpts: ICompileOptions): string[] {
        return [];
    }

    getCustomDefines(): string[] | undefined {
        return undefined;
    }

    getSystemIncludeList(builderOpts: ICompileOptions): string[] {
        const toolDir = this.getToolchainDir();
        return [
            File.fromArray([toolDir.path, 'stm8', 'inc']).path,
            File.fromArray([toolDir.path, 'stm8', 'inc', 'c']).path,
            File.fromArray([toolDir.path, 'stm8', 'inc', 'ecpp']).path,
            File.fromArray([toolDir.path, 'stm8', 'lib']).path
        ];
    }

    getForceIncludeHeaders(): string[] | undefined {
        return [
            ResManager.GetInstance().getIarStm8ForceIncludeHeaders().path
        ];
    }

    getDefaultIncludeList(): string[] {
        const toolDir = this.getToolchainDir();
        return [
            File.fromArray([toolDir.path, 'stm8', 'lib']).path
        ];
    }

    getLibDirs(): string[] {
        const toolDir = this.getToolchainDir();
        return [
            File.fromArray([toolDir.path, 'stm8', 'lib']).path
        ];
    }

    getDefaultConfig(): ICompileOptions {
        return <ICompileOptions>{
            version: this.version,
            beforeBuildTasks: [],
            afterBuildTasks: [],
            global: {
                "data-mode": "medium",
                "code-mode": "small",
                "printf-formatter": "tiny",
                "scanf-formatter": "small",
                "math-functions": "default",
                "output-debug-info": "enable"
            },
            'c/cpp-compiler': {
                "optimization": "no",
                "runtime-lib": "normal",
                "destroy-cpp-static-object": true
            },
            'asm-compiler': {
                "case-sensitive-user-symbols": true
            },
            linker: {
                "output-format": 'elf',
                "linker-config": "lnkstm8s103f3.icf",
                "auto-search-runtime-lib": true,
                "use-C_SPY-debug-lib": true,
                "config-defines": [
                    "_CSTACK_SIZE=0x0200",
                    "_HEAP_SIZE=0x0000"
                ]
            }
        };
    }
}

class RISCV_GCC implements IToolchian {

    readonly version = 1;

    readonly settingName: string = 'EIDE.RISCV.InstallDirectory';

    readonly categoryName: string = 'GCC';

    readonly name: ToolchainName = 'RISCV_GCC';

    readonly modelName: string = 'riscv.gcc.model.json';

    readonly configName: string = 'riscv.gcc.options.json';

    readonly verifyFileName: string = 'riscv.gcc.verify.json';

    private readonly defMacroList: string[];

    //---

    private incList: string[];

    constructor() {
        const gcc = File.fromArray([this.getToolchainDir().path, 'bin', this.getToolPrefix() + 'gcc.exe']);
        this.defMacroList = this.getMacroList(gcc.path);
        this.incList = this.getIncludeList(gcc.path);
    }

    private getIncludeList(gccPath: string): string[] {
        try {
            const cmdLine = CmdLineHandler.quoteString(gccPath, '"')
                + ' ' + ['-xc++', '-E', '-v', '-', '<nul 2>&1'].join(' ');
            const lines = child_process.execSync(cmdLine).toString().split(/\r\n|\n/);
            const iStart = lines.findIndex((line) => { return line.startsWith('#include <...>'); });
            const iEnd = lines.indexOf('End of search list.', iStart);
            return lines.slice(iStart + 1, iEnd)
                .map((line) => { return new File(File.ToLocalPath(line.trim())); })
                .filter((file) => { return file.IsDir(); })
                .map((f) => {
                    return f.path;
                });
        } catch (error) {
            GlobalEvent.emit('msg', ExceptionToMessage(error, 'Hidden'));
            return [];
        }
    }

    private getMacroList(gccPath: string): string[] {
        try {
            const cmdLine = CmdLineHandler.quoteString(gccPath, '"')
                + ' ' + ['-E', '-dM', '-', '<nul'].join(' ');

            const lines = child_process.execSync(cmdLine).toString().split(/\r\n|\n/);
            const results: string[] = [];
            const mHandler = new MacroHandler();

            lines.filter((line) => { return line.trim() !== ''; })
                .forEach((line) => {
                    const value = mHandler.toExpression(line);
                    if (value) {
                        results.push(value);
                    }
                });

            return results;
        } catch (error) {
            GlobalEvent.emit('msg', ExceptionToMessage(error, 'Hidden'));
            return ['__GNUC__=8', '__GNUC_MINOR__=3', '__GNUC_PATCHLEVEL__=1'];
        }
    }

    private getToolPrefix(): string {
        return SettingManager.GetInstance().getRiscvToolPrefix();
    }

    //-----------

    newInstance(): IToolchian {
        return new RISCV_GCC();
    }

    getGccCompilerPath(): string | undefined {
        const gcc = File.fromArray([this.getToolchainDir().path, 'bin', this.getToolPrefix() + 'gcc.exe']);
        return gcc.path;
    }
    
    getGccCompilerCmdArgsForIntelliSense(): string[] | undefined {
        return undefined;
    }

    preHandleOptions(prjInfo: IProjectInfo, options: ICompileOptions): void {

        // convert output lib commmand
        if (options['linker'] && options['linker']['output-format'] === 'lib') {
            options['linker']['$use'] = 'linker-lib';
        }

        // if region 'global' is not exist, create it
        if (typeof options['global'] !== 'object') {
            options['global'] = {};
        }

        // set tool prefix
        options['global'].toolPrefix = this.getToolPrefix();
    }

    getToolchainDir(): File {
        return SettingManager.GetInstance().getRiscvToolFolder();
    }

    getInternalDefines(builderOpts: ICompileOptions): string[] {
        return this.defMacroList;
    }

    getCustomDefines(): string[] | undefined {
        return undefined;
    }

    getSystemIncludeList(builderOpts: ICompileOptions): string[] {
        return Array.from(this.incList);
    }

    getForceIncludeHeaders(): string[] | undefined {
        return [
            ResManager.GetInstance().getGccForceIncludeHeaders().path
        ];
    }

    getDefaultIncludeList(): string[] {
        return [];
    }

    getLibDirs(): string[] {
        return [];
    }

    getDefaultConfig(): ICompileOptions {
        return <ICompileOptions>{
            version: this.version,
            beforeBuildTasks: [],
            afterBuildTasks: [],
            global: {
                "output-debug-info": 'enable',
                "arch": "rv32imac",
                "abi": "ilp32",
                "code-model": "medlow"
            },
            'c/cpp-compiler': {
                "language-c": "c11",
                "language-cpp": "c++11",
                "optimization": 'level-debug',
                "warnings": "all-warnings",
                "C_FLAGS": "-Wl,-Bstatic -ffunction-sections -fdata-sections",
                "CXX_FLAGS": "-ffunction-sections -fdata-sections"
            },
            'asm-compiler': {
                "ASM_FLAGS": "-Wl,-Bstatic"
            },
            linker: {
                "output-format": "elf",
                "LD_FLAGS": "-Wl,--cref -Wl,--no-relax -Wl,--gc-sections --specs=nosys.specs --specs=nano.specs -nostartfiles",
                "LIB_FLAGS": ""
            }
        };
    }
}