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

import * as fs from 'fs';
import * as vscode from 'vscode';
import * as NodePath from 'path';
import * as events from 'events';
import * as globmatch from 'micromatch'
import * as os from 'os';

import { AbstractProject, VirtualSource } from "./EIDEProject";
import { ResManager } from "./ResManager";
import { File } from "../lib/node-utility/File";
import {
    ProjectConfigData, ArmBaseCompileData,
    Memory, ARMStorageLayout, ICompileOptions,
    FloatingHardwareOption, ProjectConfiguration, C51BaseCompileData, RiscvCompileData, AnyGccCompileData
} from "./EIDETypeDefine";
import { SettingManager } from "./SettingManager";
import { GlobalEvent } from "./GlobalEvents";
import { ExceptionToMessage, newMessage } from "./Message";
import { CmdLineHandler } from "./CmdLineHandler";

import { ArrayDelRepetition } from "../lib/node-utility/Utility";
import { DependenceManager } from "./DependenceManager";
import { WorkspaceManager } from "./WorkspaceManager";
import { ToolchainName } from "./ToolchainManager";
import { md5, sha256 } from "./utility";
import { MakefileGen } from "./Makefile";
import { exeSuffix } from "./Platform";
import { FileWatcher } from "../lib/node-utility/FileWatcher";

export interface BuildOptions {

    useDebug?: boolean;

    useFastMode?: boolean;
}

export interface BuilderParams {
    name: string;
    target: string;
    toolchain: ToolchainName;
    toolchainCfgFile: string;
    toolchainLocation: string;
    buildMode: string;
    showRepathOnLog?: boolean,
    threadNum?: number;
    dumpPath: string;
    outDir: string;
    builderDir?: string;
    rootDir: string;
    ram?: number;
    rom?: number;
    sourceList: string[];
    sourceParams?: { [name: string]: string; };
    sourceParamsMtime?: number;
    incDirs: string[];
    libDirs: string[];
    defines: string[];
    options: ICompileOptions;
    sha?: { [options_name: string]: string };
    env?: { [name: string]: any };
}

export abstract class CodeBuilder {

    protected readonly paramsFileName = 'builder.params';

    protected project: AbstractProject;
    protected useFastCompile?: boolean;
    protected useShowParamsMode?: boolean;
    protected _event: events.EventEmitter;
    protected logWatcher: FileWatcher | undefined;

    constructor(_project: AbstractProject) {
        this.project = _project;
        this._event = new events.EventEmitter();
    }

    on(event: 'finished', listener: (done?: boolean) => void): void;
    on(event: any, listener: (arg: any) => void): void {
        this._event.on(event, listener);
    }

    private emit(event: 'finished', done?: boolean): void;
    private emit(event: any, arg?: any): void {
        this._event.emit(event, arg);
    }

    genSourceInfo(prevBuilderParams: BuilderParams | undefined): {
        sources: string[],
        params?: { [name: string]: string; }
        paramsModTime?: number;
    } {

        const srcList: { path: string, virtualPath?: string; }[] = [];
        const srcParams: { [name: string]: string; } = {};
        const fGoups = this.project.getFileGroups();
        const filter = AbstractProject.getSourceFileFilter();

        // filter source files
        for (const group of fGoups) {
            if (group.disabled) continue; // skip disabled group
            for (const source of group.files) {
                if (source.disabled) continue; // skip disabled file
                if (!filter.some((reg) => reg.test(source.file.path))) continue; // skip non-source
                const rePath = this.project.ToRelativePath(source.file.path, false);
                const fInfo: any = { path: rePath || source.file.path }
                if (AbstractProject.isVirtualSourceGroup(group)) {
                    fInfo.virtualPath = `${group.name}/${source.file.name}`.replace(`${VirtualSource.rootName}/`, '');
                }
                srcList.push(fInfo);
            }
        }

        // append user options for files
        try {
            const options = this.project.getSourceExtraArgsCfg();

            // parser
            const matcher = (parttenInfo: any, fieldName: string) => {
                srcList.forEach((srcInf: any) => {
                    if (!srcInf[fieldName]) return; // skip if not exist
                    for (const expr in parttenInfo) {
                        const searchPath = File.ToUnixPath(<string>srcInf[fieldName])
                            .replace(/\.\.\//g, '')
                            .replace(/\.\//g, ''); // globmatch bug ? it can't parse path which have '.' or '..'
                        if (globmatch.isMatch(searchPath, expr)) {
                            const val = parttenInfo[expr]?.trim().replace(/(?:\r\n|\n)$/, '');
                            if (val) {
                                if (srcParams[srcInf.path]) {
                                    srcParams[srcInf.path] += ` ${val}`
                                } else {
                                    srcParams[srcInf.path] = val;
                                }
                            }
                        }
                    }
                });
            };

            if (options) {

                // virtual folder files
                if (typeof options?.virtualPathFiles == 'object') {
                    const parttenInfo = options?.virtualPathFiles;
                    matcher(parttenInfo, 'virtualPath');
                }

                // filesystem files
                if (typeof options?.files == 'object') {
                    const parttenInfo = options?.files;
                    matcher(parttenInfo, 'path');
                }

                // if src options is modified to null but old is not null,
                // we need make source recompile
                if (prevBuilderParams) {
                    const oldSrcParams = prevBuilderParams.sourceParams;
                    for (const path in oldSrcParams) {
                        if (srcParams[path] == undefined && oldSrcParams[path] != undefined &&
                            oldSrcParams[path] != '') {
                            srcParams[path] = ""; // make it empty to trigger recompile 
                        }
                    }
                }
            }

        } catch (err) {
            GlobalEvent.emit('msg', ExceptionToMessage(err, 'Hidden'));
            GlobalEvent.emit('msg', newMessage('Warning', `Append files options failed !, msg: ${err.message || ''}`));
        }

        let mTimeMs: number | undefined;

        try {
            mTimeMs = fs.statSync(this.project.getSourceExtraArgsCfgFile().path).mtimeMs
        } catch (error) {
            // do nothing
        }

        return {
            sources: srcList.map((inf) => inf.path),
            params: srcParams,
            paramsModTime: mTimeMs
        }
    }

    getIncludeDirs(): string[] {

        const incList = this.project.GetConfiguration().GetAllMergeDep([
            `${ProjectConfiguration.BUILD_IN_GROUP_NAME}.${DependenceManager.toolchainDepName}`
        ]).incList;

        return ArrayDelRepetition(incList.concat(
            this.project.getToolchain().getDefaultIncludeList(),
            this.project.getSourceIncludeList()
        ));
    }

    getDefineList(): string[] {
        return this.project.GetConfiguration().GetAllMergeDep().defineList;
    }

    getLibDirs(): string[] {
        return this.project.GetConfiguration()
            .GetAllMergeDep([
                `${ProjectConfiguration.BUILD_IN_GROUP_NAME}.${DependenceManager.toolchainDepName}`
            ]).libList;
    }

    protected enableRebuild(_enable: boolean = true) {
        this.useFastCompile = !_enable;
    }

    protected isRebuild(): boolean {
        return !this.useFastCompile;
    }

    build(options?: BuildOptions): void {

        let commandLine = this.genBuildCommand(options);
        if (!commandLine) return;

        const title = options?.useDebug ? 'compiler params' : 'build';

        // watch log, to emit done event
        try {

            const checkBuildDone = (logFile: File): boolean => {
                try {
                    // [2022-xx-xx 15:07:53]	[done]
                    const revLines = logFile.Read().split(/\r\n|\n/).reverse();
                    const idx = revLines.findIndex(line => /^\[\d+\-\d+\-\d+ [^\]]+\]/.test(line));
                    if (idx == -1) { return false; }
                    return /\[done\]\s*$/i.test(revLines[idx]);
                } catch (error) {
                    return false;
                }
            };

            const outDir = this.project.ToAbsolutePath(this.project.getOutputDir());
            const builderLog = File.fromArray([outDir, 'unify_builder.log']);
            if (!builderLog.IsFile()) builderLog.Write('');
            if (this.logWatcher) { this.logWatcher.Close(); delete this.logWatcher; };

            // start watch
            this.logWatcher = new FileWatcher(builderLog, false);
            this.logWatcher.OnChanged = () => {
                this.logWatcher?.Close();
                this.emit('finished', checkBuildDone(builderLog));
            };
            this.logWatcher.Watch();
        } catch (error) {
            GlobalEvent.emit('msg', ExceptionToMessage(error, 'Hidden'));
        }

        // run build
        if (SettingManager.GetInstance().isUseTaskToBuild() && WorkspaceManager.getInstance().hasWorkspaces()) {
            // use task
            const task = new vscode.Task({ type: 'shell' }, vscode.TaskScope.Workspace, title, 'shell');
            const shellOption: vscode.ShellExecutionOptions = {};
            if (os.platform() == 'win32') { shellOption.executable = 'cmd.exe'; shellOption.shellArgs = ['/C']; }
            else { shellOption.executable = '/bin/bash'; shellOption.shellArgs = ['-c']; }
            shellOption.env = <any>process.env;
            if (os.platform() == 'win32') commandLine = `"${commandLine}"`;
            task.execution = new vscode.ShellExecution(commandLine, shellOption);
            task.problemMatchers = this.getProblemMatcher();
            task.isBackground = false;
            task.presentationOptions = { echo: true, focus: false, clear: true };
            vscode.tasks.executeTask(task);
        } else {
            // use terminal
            const index = vscode.window.terminals.findIndex((t) => { return t.name === title; });
            if (index !== -1) { vscode.window.terminals[index].dispose(); }
            const opts: vscode.TerminalOptions = { name: title };
            if (os.platform() == 'win32') { opts.shellPath = 'cmd.exe'; };
            opts.env = <any>process.env;
            const terminal = vscode.window.createTerminal(opts);
            terminal.show(true);
            terminal.sendText(commandLine);
        }
    }

    genBuildCommand(options?: BuildOptions, disPowershell?: boolean): string | undefined {

        const resManager = ResManager.GetInstance();

        // reinit build mode
        this.useFastCompile = options?.useFastMode;
        this.useShowParamsMode = options?.useDebug;

        /* if not found toolchain, exit ! */
        if (!this.project.checkAndNotifyInstallToolchain()) { return; }

        const prjConfig = this.project.GetConfiguration();
        const outDir = new File(this.project.ToAbsolutePath(prjConfig.getOutDir()));
        outDir.CreateDir(true);

        // generate command line
        const commandLine = CmdLineHandler.getCommandLine(
            this.getBuilderExe().noSuffixName,
            this.getCommands()
        );

        return commandLine;
    }

    private genHashFromCompilerOptions(builderOptions: BuilderParams): any {

        const res: any = {};

        if (typeof builderOptions['defines'] == 'object') {
            res['c/cpp-defines'] = md5(JSON.stringify(builderOptions['defines']));
        }

        const options: any = builderOptions.options;

        for (const key in options) {
            if (typeof options[key] == 'object') {
                res[key] = md5(JSON.stringify(options[key]));
            }
        }

        return res;
    }

    private compareHashObj(key: string, hashObj_1?: { [key: string]: string }, hashObj_2?: { [key: string]: string }): boolean {

        if (hashObj_1 == hashObj_2 == undefined) {
            return true;
        }

        if (hashObj_1 && hashObj_2) {

            if (hashObj_1[key] == hashObj_2[key] == undefined) {
                return true;
            }

            return hashObj_1[key] == hashObj_2[key];
        }

        return false;
    }

    private getCommands(): string[] {

        const config = this.project.GetConfiguration().config;
        const settingManager = SettingManager.GetInstance();
        const toolchain = this.project.getToolchain();

        const outDir = File.ToUnixPath(this.project.getOutputDir());
        const paramsPath = this.project.ToAbsolutePath(outDir + File.sep + this.paramsFileName);
        const compileOptions: ICompileOptions = this.project.GetConfiguration()
            .compileConfigModel.getOptions(this.project.getEideDir().path, config);
        const memMaxSize = this.getMaxSize();
        const oldParamsPath = `${paramsPath}.old`;
        const prevParams: BuilderParams | undefined = File.IsFile(oldParamsPath) ? JSON.parse(fs.readFileSync(oldParamsPath, 'utf8')) : undefined;
        const sourceInfo = this.genSourceInfo(prevParams);
        const builderModeList: string[] = []; // build mode

        const builderOptions: BuilderParams = {
            name: config.name,
            target: this.project.getCurrentTarget(),
            toolchain: toolchain.name,
            toolchainLocation: toolchain.getToolchainDir().path,
            toolchainCfgFile: NodePath.normalize(`../cfg/${toolchain.modelName}`),
            buildMode: 'fast|multhread',
            showRepathOnLog: settingManager.isPrintRelativePathWhenBuild(),
            threadNum: settingManager.getThreadNumber(),
            rootDir: this.project.GetRootDir().path,
            dumpPath: File.ToLocalPath(outDir),
            outDir: File.ToLocalPath(outDir),
            ram: memMaxSize?.ram,
            rom: memMaxSize?.rom,
            incDirs: this.getIncludeDirs().map((incPath) => { return this.project.ToRelativePath(incPath, false) || incPath; }),
            libDirs: this.getLibDirs().map((libPath) => { return this.project.ToRelativePath(libPath, false) || libPath; }),
            defines: this.getDefineList(),
            sourceList: sourceInfo.sources.sort(),
            sourceParams: sourceInfo.params,
            sourceParamsMtime: sourceInfo.paramsModTime,
            options: JSON.parse(JSON.stringify(compileOptions)),
            env: this.project.getProjectEnv()
        };

        // set ram size from env
        if (builderOptions.ram == undefined &&
            builderOptions.env &&
            builderOptions.env['MCU_RAM_SIZE']) {
            builderOptions.ram = parseInt(builderOptions.env['MCU_RAM_SIZE']) || undefined;
        }

        // set rom size from env
        if (builderOptions.rom == undefined &&
            builderOptions.env &&
            builderOptions.env['MCU_ROM_SIZE']) {
            builderOptions.rom = parseInt(builderOptions.env['MCU_ROM_SIZE']) || undefined;
        }

        // handle options by toolchain
        toolchain.preHandleOptions({
            targetName: config.name,
            toAbsolutePath: (path) => this.project.ToAbsolutePath(path),
            getOutDir: () => { return this.project.ToAbsolutePath(outDir); }
        }, builderOptions.options);

        // handle options
        this.preHandleOptions(builderOptions.options);

        // generate hash for compiler options
        builderOptions.sha = this.genHashFromCompilerOptions(builderOptions);

        // set build mode
        {
            // check whether need rebuild project
            if (this.isRebuild() == false && prevParams) {
                try {
                    // not found hash from old params file
                    if (prevParams.sha == undefined) {
                        this.enableRebuild();
                    }

                    // check hash obj by specifies keys
                    else {
                        const keyList = ['global', 'c/cpp-defines', 'c/cpp-compiler', 'asm-compiler'];
                        for (const key of keyList) {
                            if (!this.compareHashObj(key, prevParams.sha, builderOptions.sha)) {
                                this.enableRebuild();
                                break;
                            }
                        }
                    }
                } catch (error) {
                    this.enableRebuild(); // make rebuild
                    GlobalEvent.emit('msg', ExceptionToMessage(error, 'Hidden'));
                }
            }

            if (config.toolchain === 'Keil_C51') { // disable increment compile for Keil C51
                builderModeList.push('normal');
            } else {
                builderModeList.push(this.isRebuild() ? 'normal' : 'fast');
            }

            if (settingManager.isUseMultithreadMode()) {
                builderModeList.push('multhread');
            }

            if (this.useShowParamsMode) {
                builderModeList.push('debug');
            }

            // set build mode
            builderOptions.buildMode = builderModeList.map(str => str.toLowerCase()).join('|');
        }

        if (config.toolchain === 'MM32CC') {
            builderOptions.toolchainCfgFile = ResManager.GetInstance().GetAppDataDir().path.concat( File.sep, 'mm.mm32cc.model.json');
        }

        // write project build params
        fs.writeFileSync(paramsPath, JSON.stringify(builderOptions, undefined, 4));

        // generate makefile params
        if (settingManager.isGenerateMakefileParams()) {
            try {
                const gen = new MakefileGen();
                gen.generateParamsToFile(builderOptions, this.project.ToAbsolutePath(config.outDir));
            } catch (error) {
                GlobalEvent.emit('msg', ExceptionToMessage(error, 'Hidden'));
            }
        }

        let cmds = [
            '-p', paramsPath,
        ];

        const extraCmd = settingManager.getBuilderAdditionalCommandLine()?.trim();
        if (extraCmd) {
            cmds = cmds.concat(extraCmd.split(/\s+/));
        }

        return cmds;
    }

    private getBuilderExe(): File {
        return ResManager.GetInstance().getBuilder();
    }

    protected abstract getMaxSize(): MemorySize | undefined;

    protected abstract preHandleOptions(options: ICompileOptions): void;

    protected abstract getProblemMatcher(): string[];

    static NewBuilder(_project: AbstractProject): CodeBuilder {
        switch (_project.GetConfiguration().config.type) {
            case 'ARM':
                return new ARMCodeBuilder(_project);
            case 'RISC-V':
                return new RiscvCodeBuilder(_project);
            case 'ANY-GCC':
                return new AnyGccCodeBuilder(_project);
            case 'C51':
                return new C51CodeBuilder(_project);
            default:
                throw new Error(`not support this project type: '${_project.GetConfiguration().config.type}'`);
        }
    }
}

interface MemorySize {
    ram?: number;
    rom?: number;
}

interface RomItem {
    memInfo: Memory;
    selected: boolean;
}

interface RamItem {
    memInfo: Memory;
    selected: boolean;
    noInit: boolean;
}

interface MemoryScatter {
    startUpIndex: number;
    romList: RomItem[];
    ramList: RamItem[];
}

interface MemoryText {
    name: string;
    addr: string;
    content: string;
    child: MemoryText[];
}

export class ARMCodeBuilder extends CodeBuilder {

    constructor(_project: AbstractProject) {
        super(_project);
    }

    private EmptyMemoryScatter(): MemoryScatter {
        let memScatter: MemoryScatter = {
            startUpIndex: -1,
            romList: [],
            ramList: []
        };

        for (let i = 0; i < 5; i++) {
            memScatter.romList.push({
                memInfo: {
                    startAddr: '0x00000000',
                    size: '0x00000000'
                },
                selected: false
            });
            memScatter.ramList.push({
                memInfo: {
                    startAddr: '0x00000000',
                    size: '0x00000000'
                },
                selected: false,
                noInit: false
            });
        }

        return memScatter;
    }

    private FillHexNumber(num: string): string {
        if (num.length >= 10) {
            return num;
        }
        let str = '0x';
        for (let i = 0; i < (10 - num.length); i++) {
            str += '0';
        }
        return str + num.substring(2);
    }

    private GetMemoryScatter(_storageLayout: ARMStorageLayout): MemoryScatter {

        let memScatter = this.EmptyMemoryScatter();
        memScatter.startUpIndex = -1;

        const storageLayout: ARMStorageLayout = JSON.parse(JSON.stringify(_storageLayout));

        let index = 0;
        for (let i = 0; i < storageLayout.RAM.length; i++) {

            switch (storageLayout.RAM[i].tag) {
                case 'IRAM':
                    index = storageLayout.RAM[i].id + 2;
                    break;
                case 'RAM':
                    index = storageLayout.RAM[i].id - 1;
                    break;
                default:
                    throw Error('Unknown RAM Tag !');
            }

            memScatter.ramList[index].memInfo = storageLayout.RAM[i].mem;
            memScatter.ramList[index].memInfo.startAddr = this.FillHexNumber(storageLayout.RAM[i].mem.startAddr);
            memScatter.ramList[index].memInfo.size = this.FillHexNumber(storageLayout.RAM[i].mem.size);
            memScatter.ramList[index].selected = storageLayout.RAM[i].isChecked;
            memScatter.ramList[index].noInit = storageLayout.RAM[i].noInit;
        }

        for (let i = 0; i < storageLayout.ROM.length; i++) {

            switch (storageLayout.ROM[i].tag) {
                case 'IROM':
                    index = storageLayout.ROM[i].id + 2;
                    break;
                case 'ROM':
                    index = storageLayout.ROM[i].id - 1;
                    break;
                default:
                    throw Error('Unknown ROM Tag !');
            }

            memScatter.romList[index].memInfo = storageLayout.ROM[i].mem;
            memScatter.romList[index].memInfo.startAddr = this.FillHexNumber(storageLayout.ROM[i].mem.startAddr);
            memScatter.romList[index].memInfo.size = this.FillHexNumber(storageLayout.ROM[i].mem.size);
            memScatter.romList[index].selected = storageLayout.ROM[i].isChecked;
            memScatter.startUpIndex = storageLayout.ROM[i].isStartup ? index : memScatter.startUpIndex;
        }

        if (memScatter.startUpIndex === -1) {
            throw Error('MemScatter.startupIndex can\'t be -1');
        }
        else if (!memScatter.romList[memScatter.startUpIndex].selected) {
            throw Error('the IROM' + (memScatter.startUpIndex - 2).toString() + ' is a startup ROM but it is not selected !');
        }

        return memScatter;
    }

    private GenMemTxtBySct(memScatter: MemoryScatter): MemoryText[] {

        const getRomName = (index: number, isChild: boolean): string => {
            let name = isChild ? 'ER_' : 'LR_';
            let num = index + 1;
            if (num > 3) {
                name += 'I';
                num = num - 3;
            }
            return name + 'ROM' + num.toString();
        };
        const getRamName = (index: number) => {
            let name = 'RW_';
            let num = index + 1;
            if (num > 3) {
                name += 'I';
                num = num - 3;
            }
            return name + 'RAM' + num.toString();
        };

        const memTxt: MemoryText[] = [];

        const staUpInfo = memScatter.romList[memScatter.startUpIndex].memInfo;

        const staUpTxt: MemoryText = {
            name: getRomName(memScatter.startUpIndex, false),
            addr: ' ' + staUpInfo.startAddr + ' ' + staUpInfo.size + ' ',
            content: '',
            child: []
        };
        staUpTxt.child.push({
            name: getRomName(memScatter.startUpIndex, true),
            addr: ' ' + staUpInfo.startAddr + ' ' + staUpInfo.size + ' ',
            content: '*.o (RESET, +First) \r\n*(InRoot$$Sections) \r\n.ANY (+RO) \r\n.ANY (+XO) \r\n',
            child: []
        });

        //RAM
        memScatter.ramList.forEach((item, index) => {
            if (item.selected) {
                staUpTxt.child.push({
                    name: getRamName(index),
                    addr: ' ' + item.memInfo.startAddr + (item.noInit ? ' UNINIT ' : ' ') + item.memInfo.size + ' ',
                    content: '.ANY (+RW +ZI) \r\n',
                    child: []
                });
            }
        });

        memTxt.push(staUpTxt);

        memScatter.romList.forEach((item, index) => {
            if (item.selected && index !== memScatter.startUpIndex) {
                memTxt.push({
                    name: getRomName(index, false),
                    addr: ' ' + item.memInfo.startAddr + ' ' + item.memInfo.size + ' ',
                    content: '',
                    child: [{
                        name: getRomName(index, true),
                        addr: ' ' + item.memInfo.startAddr + ' ' + item.memInfo.size + ' ',
                        content: '.ANY (+RO) \r\n',
                        child: []
                    }]
                });
            }
        });

        return memTxt;
    }

    private GenMemScatterFile(config: ProjectConfigData<ArmBaseCompileData>): File {

        const sctFile = new File(this.project.ToAbsolutePath(this.project.getOutputDir()
            + File.sep + config.name + '.sct'));

        let data = '';
        const memTxt = this.GenMemTxtBySct(this.GetMemoryScatter(config.compileConfig.storageLayout));

        memTxt.forEach(tItem => {
            let str = tItem.name + tItem.addr + '{\r\n';

            if (tItem.child.length > 0) {
                tItem.child.forEach(v => {
                    str += v.name + v.addr + '{\r\n';
                    str += v.content;
                    str += '}\r\n';
                });
            } else {
                str += tItem.content;
            }

            str += '}\r\n\r\n';
            data += str;
        });

        // indent sct text
        const lines = data.split(/\r\n|\n/);
        let braceCount = 0;
        for (let index = 0; index < lines.length; index++) {

            const line = lines[index];

            if (line.endsWith('}')) {
                braceCount--;
            }

            if (braceCount > 0 && line.trim() !== '') {
                lines[index] = '\t'.repeat(braceCount) + line;
            }

            if (line.endsWith('{')) {
                braceCount++;
            }
        }

        const title =
            '; ******************************************************************' + '\r\n' +
            '; *** Scatter-Loading Description File generated by Embedded IDE ***' + '\r\n' +
            '; ******************************************************************' + '\r\n\r\n';
        data = lines.join('\r\n');
        sctFile.Write(title + data);

        return sctFile;
    }

    // 用于生成带有浮点类型后缀的 cpu 系列名，用作代号
    static genCpuId(cpu: string, hardOption: FloatingHardwareOption): string {

        let suffix: string = '';

        cpu = cpu.toLowerCase();

        switch (hardOption) {
            case 'no_dsp':
                // nothing
                break;
            case 'single':
                if (cpu.endsWith('m33') || cpu.endsWith('m4') || cpu.endsWith('m7')) {
                    suffix = '-sp';
                }
                break;
            case 'double':
                if (cpu.endsWith('m4') || cpu.endsWith('m7')) {
                    suffix = '-dp';
                }
                break;
            default: // none
                if (cpu.endsWith('m33') || cpu.endsWith('m4') || cpu.endsWith('m7')) {
                    suffix = '-none';
                }
                break;
        }

        return cpu + suffix;
    }

    protected getMaxSize(): MemorySize | undefined {

        const prjConfig = this.project.GetConfiguration<ArmBaseCompileData>();

        if (!prjConfig.config.compileConfig.useCustomScatterFile) {

            const memLayout: ARMStorageLayout = JSON.parse(JSON.stringify(prjConfig.config.compileConfig.storageLayout));
            const res: MemorySize = {};

            try {
                let romSize = 0;
                for (const rom of memLayout.ROM) {
                    if (rom.isChecked) {
                        romSize += parseInt(rom.mem.size);
                    }
                }
                res.rom = !isNaN(romSize) ? romSize : undefined;
            } catch (error) {
                GlobalEvent.emit('msg', ExceptionToMessage(error, 'Hidden'));
            }

            try {
                let ramSize = 0;
                for (const ram of memLayout.RAM) {
                    if (ram.isChecked) {
                        ramSize += parseInt(ram.mem.size);
                    }
                }
                res.ram = !isNaN(ramSize) ? ramSize : undefined;
            } catch (error) {
                GlobalEvent.emit('msg', ExceptionToMessage(error, 'Hidden'));
            }

            return res;
        }

        return undefined;
    }

    protected getProblemMatcher(): string[] {
        switch (this.project.getToolchain().name) {
            case 'AC5':
                return ['$armcc'];
            default:
                return ['$gcc'];
        }
    }

    protected preHandleOptions(options: ICompileOptions) {

        const config = this.project.GetConfiguration<ArmBaseCompileData>().config;
        const toolchain = this.project.getToolchain();
        const settingManager = SettingManager.GetInstance();

        const cpuString = ARMCodeBuilder.genCpuId(
            config.compileConfig.cpuType.toLowerCase(), config.compileConfig.floatingPointHardware
        );

        if (!options.global) {
            options.global = Object.create(null);
        }

        options.global['microcontroller-cpu'] = cpuString;
        options.global['microcontroller-fpu'] = cpuString;
        options.global['microcontroller-float'] = cpuString;
        options.global['target'] = cpuString; // params for 'armclang-asm'

        if (['MM32CC'].includes(config.toolchain)) {
            options.global['$linker-config'] = cpuString;
        }
        
        if (!options['linker']) {
            options.linker = Object.create(null);
        }

        const ldFileList: string[] = [];

        let scatterFilePath: string = config.compileConfig.scatterFilePath;
        if (scatterFilePath == 'undefined') {
            scatterFilePath = `${scatterFilePath}.sct`;
        }

        // 'armcc' can select whether use custom linker file
        if (['AC5', 'AC6'].includes(toolchain.name)) {
            // use custom linker script files
            if (config.compileConfig.useCustomScatterFile) {
                scatterFilePath.split(',').forEach((sctPath) => {
                    ldFileList.push(`"${File.ToUnixPath(this.project.ToAbsolutePath(sctPath))}"`);
                });
            }
            // auto generate scatter file 
            else {
                ldFileList.push(`"${File.ToUnixPath(this.GenMemScatterFile(config).path)}"`);
            }
        }

        // other toolchain must use custom linker script file
        else {
            scatterFilePath.split(',').forEach((sctPath) => {
                ldFileList.push(`"${File.ToUnixPath(this.project.ToAbsolutePath(sctPath))}"`);
            });
        }

        // set linker script
        options.linker['link-scatter'] = ldFileList;

        if (options.afterBuildTasks === undefined) {
            options.afterBuildTasks = [];
        }

        if (options['linker']['output-format'] !== 'lib') {

            const extraCommands: any[] = [];

            // convert elf
            if (['AC5', 'AC6'].includes(config.toolchain) && settingManager.IsConvertAxf2Elf()) {

                const tool_root_folder = toolchain.getToolchainDir().path;
                const ouput_path = `\${outDir}${File.sep}${config.name}`;
                const axf2elf_log = `\${outDir}${File.sep}axf2elf.log`;

                extraCommands.push({
                    name: 'axf to elf',
                    command: `axf2elf -d "${tool_root_folder}" -b "${ouput_path}.bin" -i "${ouput_path}.axf" -o "${ouput_path}.elf" > "${axf2elf_log}"`
                });
            }

            // insert command lines
            if (settingManager.isInsertCommandsAtBegin()) {
                options.afterBuildTasks = extraCommands.concat(options.afterBuildTasks);
            } else {
                options.afterBuildTasks = options.afterBuildTasks.concat(extraCommands);
            }
        }
    }
}

class RiscvCodeBuilder extends CodeBuilder {

    protected getProblemMatcher(): string[] {
        return ['$gcc'];
    }

    protected getMaxSize(): MemorySize | undefined {
        return undefined;
    }

    protected preHandleOptions(options: ICompileOptions) {

        const config = this.project.GetConfiguration<RiscvCompileData>().config;

        const ldFileList: string[] = [];
        config.compileConfig.linkerScriptPath.split(',').forEach((sctPath) => {
            ldFileList.push(`"${File.ToUnixPath(this.project.ToAbsolutePath(sctPath))}"`);
        });

        if (!options['linker']) {
            options.linker = Object.create(null);
        }

        // set linker script
        options.linker['linker-script'] = ldFileList;
    }
}

class AnyGccCodeBuilder extends CodeBuilder {

    protected getProblemMatcher(): string[] {
        return ['$gcc'];
    }

    protected getMaxSize(): MemorySize | undefined {
        return undefined;
    }

    protected preHandleOptions(options: ICompileOptions) {

        const config = this.project.GetConfiguration<AnyGccCompileData>().config;

        if (!options['linker']) {
            options.linker = Object.create(null);
        }

        // set linker script
        if (config.compileConfig.linkerScriptPath.trim() !== '') {
            options.linker['linker-script'] = config.compileConfig.linkerScriptPath.split(',').map((sctPath) => {
                const absPath = File.ToUnixPath(this.project.ToAbsolutePath(sctPath));
                return absPath.includes(' ') ? `"${absPath}"` : absPath;
            });
        } else { // clear old
            if (options.linker['linker-script']) {
                delete options.linker['linker-script'];
            }
        }
    }
}

class C51CodeBuilder extends CodeBuilder {

    protected getProblemMatcher(): string[] {
        switch (this.project.getToolchain().name) {
            case 'SDCC':
                return ['$gcc'];
            case 'Keil_C51':
                return ['$keilc51'];
            default:
                return [];
        }
    }

    protected getMaxSize(): MemorySize | undefined {
        return undefined;
    }

    protected preHandleOptions(options: ICompileOptions) {

        const config = this.project.GetConfiguration<C51BaseCompileData>().config;
        const toolchain = this.project.getToolchain();

        /* set linker script if it's existed */
        if (config.compileConfig.linkerScript) {

            const ldFileList: string[] = [];

            config.compileConfig.linkerScript.split(',').forEach((sctPath) => {
                ldFileList.push(`"${File.ToUnixPath(this.project.ToAbsolutePath(sctPath))}"`);
            });

            if (!options['linker']) {
                options.linker = Object.create(null);
            }

            // set linker script for stm8 gnu sdcc
            if (toolchain.name == 'GNU_SDCC_STM8') {
                options.linker['linker-script'] = ldFileList;
            }
        }
    }
}
