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

import * as xml2js from 'x2js';
import { File } from '../lib/node-utility/File';
import {
    ProjectType, CurrentDevice, FileGroup, C51BaseCompileData, ProjectConfiguration,
    ArmBaseCompileData, ARMStorageLayout, ArmBaseCompileConfigModel, ICompileOptions
} from './EIDETypeDefine';
import { ToolchainName, ToolchainManager } from './ToolchainManager';
import { AbstractProject } from './EIDEProject';
import { GlobalEvent } from './GlobalEvents';
import { ExceptionToMessage } from './Message';
import { ResManager } from './ResManager';
import * as NodePath from 'path';
import { DependenceManager } from './DependenceManager';
import { ArrayDelRepetition } from '../lib/node-utility/Utility';

export interface KeilRteDependence {
    class?: string;
    category?: string;
    packPath?: string;
    instance?: string[];
    path: string;
}

export interface KeilParserResult<CompileOption> {
    name: string;
    type: ProjectType;
    device: string;
    vendor: string;
    incList: string[];
    defineList: string[];
    fileGroups: FileGroup[];
    compileOption: CompileOption;
    rte_deps?: KeilRteDependence[];
}

export interface ICompileOptionsGroup {
    [tag: string]: ICompileOptions;
}

export interface ICommonOptions {
    toolchain: ToolchainName;
    optionsGroup: ICompileOptionsGroup;
}

export abstract class KeilParser<T> {

    static TYPE_SUFFIX_MAP = {
        'ARM': '.uvprojx',
        'C51': '.uvproj',
    };

    public abstract readonly TYPE_TAG: ProjectType;

    protected parser: xml2js;
    protected _file: File;
    private _folder: File;
    protected doc: any;

    constructor(_file: File) {
        this._file = _file;
        this._folder = new File(_file.dir);
        this.parser = new xml2js({
            attributePrefix: '$',
            enableToStringFunc: true,
            arrayAccessFormPaths: [
                'Project.Targets.Target',
                'Project.Targets.Target.Groups.Group',
                'Project.Targets.Target.Groups.Group.Files',
                'Project.Targets.Target.Groups.Group.Files.File',
                'Project.RTE.files',
                'Project.RTE.files.file',
                'Project.RTE.files.file.instance'
            ]
        });
        this.doc = this.parser.xml2js<any>(this._file.Read());
    }

    protected SplitPathSeparator(str: string, sep: string | RegExp): string[] {

        const _list: string[] = [];

        str.split(sep).forEach((value: string) => {
            if (value !== '') {
                _list.push(value.trim());
            }
        });

        return _list;
    }

    protected parseMacroString(str: string): string[] {

        const result: string[] = [];
        const charStack: string[] = [];

        const pushToResult = (str: string) => {
            const macro = str.trim();
            if (macro && /^[_a-z].*/i.test(macro)) {
                result.push(macro);
            }
        };

        let curSubStr: string = '';
        for (let index = 0; index < str.length; index++) {

            let prevChar = index > 0 ? str[index - 1] : '';
            let curChar = str[index];

            // string char
            if (curChar === '"' || curChar === '\'') {
                if (prevChar !== '\\') { // ignore '\"' in string
                    if (charStack.length > 0) {
                        if (charStack[charStack.length - 1] === curChar) {
                            charStack.pop();
                            // force make ' => "
                            if (curChar === '\'') { curChar = '"'; }
                        }
                    }
                    else {
                        charStack.push(curChar);
                        // force make ' => "
                        if (curChar === '\'') { curChar = '"'; }
                    }
                }
            }
            // split char
            else if (curChar === ' ' || curChar === ',') {
                if (charStack.length === 0) {
                    pushToResult(curSubStr);
                    curSubStr = ''; // reset it
                    continue; // skip split char
                }
            }

            curSubStr += curChar;
        }

        // push remaining str
        pushToResult(curSubStr);

        return result;
    }

    protected JudgeFileType(f: File): number {
        switch (f.suffix.toLowerCase()) {
            case '.c':
                return 1;
            case '.s':
            case '.a51':
                return 2;
            case '.cpp':
                return 8;
            default:
                return 5;
        }
    }

    // example: file: 'c:\aa\bb', path: '../cc/f.txt', result: 'c:\aa\cc\f.txt'
    protected ToAbsolutePath(path: string): string {
        if (File.isAbsolute(path)) {
            return path.replace(/\//g, '\\');
        } else {
            return NodePath.normalize(this._file.dir + File.sep + path);
        }
    }

    protected ToRelativePath(path: string): string {
        return this._folder.ToRelativePath(path) || path;
    }

    protected FixGroupName(groupName: string): string {
        return groupName.trim()
            .replace(/^(?:\\|\/){1,}/, '')  // '/TEST' -> 'TEST'
            .replace(/\\{1,}/g, '/');       // 'TEST\\A' -> 'TEST/A'
    }

    protected isFileDisabled(fileObj: any): boolean | undefined {
        if (fileObj.FileOption && fileObj.FileOption.CommonProperty) {
            if (fileObj.FileOption.CommonProperty.IncludeInBuild === '0') {
                return true;
            }
        }
    }

    protected setFileDisableFlag(fileObj: any, disable?: boolean) {

        if (disable) {

            if (fileObj.FileOption === undefined) {
                fileObj.FileOption = { CommonProperty: {} };
            }

            if (fileObj.FileOption.CommonProperty === undefined) {
                fileObj.FileOption.CommonProperty = Object.create(null);
            }

            fileObj.FileOption.CommonProperty.IncludeInBuild = '0';
        }
    }

    protected isGroupDisabled(groupObj: any): boolean | undefined {
        if (groupObj.GroupOption && groupObj.GroupOption.CommonProperty) {
            if (groupObj.GroupOption.CommonProperty.IncludeInBuild === '0') {
                return true;
            }
        }
    }

    protected setGroupDisableFlag(groupObj: any, disable?: boolean) {

        if (disable) {

            if (groupObj.GroupOption === undefined) {
                groupObj.GroupOption = { CommonProperty: {} };
            }

            if (groupObj.GroupOption.CommonProperty === undefined) {
                groupObj.GroupOption.CommonProperty = Object.create(null);
            }

            groupObj.GroupOption.CommonProperty.IncludeInBuild = '0';
        }
    }

    static GetProjectType(f: File): ProjectType {
        if (/.uvproj$/i.test(f.suffix)) {
            return 'C51';
        }
        return 'ARM';
    }

    static NewInstance(file: File): KeilParser<any> {
        switch (this.GetProjectType(file)) {
            case 'C51':
                return new C51Parser(file);
            case 'ARM':
                return new ARMParser(file);
            default:
                throw new Error(`not support this project type: '${this.GetProjectType(file)}'`);
        }
    }

    Save(outDir: File, name: string): File {
        const prjMap: any = KeilParser.TYPE_SUFFIX_MAP;
        if (prjMap[this.TYPE_TAG] == undefined) { throw new Error(`Not support '${this.TYPE_TAG}' project !`); }
        const outFile = File.fromArray([outDir.path, name + prjMap[this.TYPE_TAG]]);
        const header = '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>';
        outFile.Write(header + this.parser.js2xml<any>(this.doc));
        return outFile;
    }

    abstract ParseData(): KeilParserResult<T>[];

    abstract SetKeilXml(prj: AbstractProject, fileGroups: FileGroup[], deviceInfo?: CurrentDevice): void;
}

//----

export interface KeilC51Option extends C51BaseCompileData, ICommonOptions {
    includeFolder: string;
}

class C51Parser extends KeilParser<KeilC51Option> {

    TYPE_TAG: ProjectType = 'C51';

    constructor(f: File) {
        super(f);
    }

    private getOption(targetOptionObj: any, option: KeilC51Option) {

        const target51 = targetOptionObj.Target51;

        option.optionsGroup = Object.create(null);
        const cOptions: ICompileOptions = option.optionsGroup['Keil_C51'] = Object.create(null);

        cOptions['global'] = Object.create(null);
        cOptions['c/cpp-compiler'] = Object.create(null);
        cOptions['asm-compiler'] = Object.create(null);
        cOptions['linker'] = Object.create(null);

        try {
            if (target51.Target51Misc) {
                switch (target51.Target51Misc.MemoryModel) {
                    case '0':
                        cOptions['global']['ram-mode'] = 'SMALL';
                        break;
                    case '1':
                        cOptions['global']['ram-mode'] = 'COMPACT';
                        break;
                    case '2':
                        cOptions['global']['ram-mode'] = 'LARGE';
                        break;
                    default:
                        break;
                }
                switch (target51.Target51Misc.RomSize) {
                    case '0':
                        cOptions['global']['rom-mode'] = 'SMALL';
                        break;
                    case '1':
                        cOptions['global']['rom-mode'] = 'COMPACT';
                        break;
                    case '2':
                        cOptions['global']['rom-mode'] = 'LARGE';
                        break;
                    default:
                        break;
                }
            }

            if (target51.C51) {
                cOptions['c/cpp-compiler']['optimization-type'] = target51.C51.SizeSpeed === '0' ? 'SIZE' : 'SPEED';
                cOptions['c/cpp-compiler']['optimization-level'] = 'level-' + (target51.C51.Optimize || '8');
            }
        } catch (error) {
            GlobalEvent.emit('msg', ExceptionToMessage(error, 'Warning'));
            GlobalEvent.emit('msg', {
                type: 'Warning',
                contentType: 'string',
                content: '编译配置导入失败！请手动完成设置'
            });
        }
    }

    ParseData(): KeilParserResult<KeilC51Option>[] {

        const result: KeilParserResult<KeilC51Option>[] = [];

        for (const target of this.doc.Project.Targets.Target) {

            const obj = <KeilParserResult<KeilC51Option>>Object.create(null);

            obj.name = target.TargetName;

            obj.type = this.TYPE_TAG;

            obj.device = target.TargetOption.TargetCommonOption.Device;

            obj.incList = this.SplitPathSeparator(
                target.TargetOption.Target51.C51.VariousControls.IncludePath, new RegExp(File.delimiter + '\\s*'))
                .map<string>((path) => { return this.ToAbsolutePath(path); });

            obj.defineList = this.parseMacroString(target.TargetOption.Target51.C51.VariousControls.Define);

            obj.compileOption = Object.create(null);
            obj.compileOption.includeFolder = (target.TargetOption.TargetCommonOption.RegisterFilePath || '')
                .replace(/(?:\\|\/)$/, '');
            obj.compileOption.toolchain = 'Keil_C51';
            this.getOption(target.TargetOption, obj.compileOption);

            const groups = target.Groups;
            obj.fileGroups = [];

            if (groups !== undefined && groups.Group !== undefined) {

                groups.Group.forEach((group: { GroupName: string, Files: any[] }) => {
                    const fGroup = <FileGroup>{ name: '', files: [] };

                    fGroup.name = this.FixGroupName(group.GroupName);
                    fGroup.disabled = this.isGroupDisabled(group);

                    if (group.Files && group.Files.length > 0) {

                        // combine list
                        group.Files.slice(1).forEach((FILE) => {
                            group.Files[0].File = group.Files[0].File.concat(FILE.File);
                        });

                        group.Files[0].File.forEach((node: { FileName: string, FileType: string, FilePath: string }) => {
                            const fPath = node.FilePath;
                            if (fPath !== undefined) {
                                fGroup.files.push({
                                    file: new File(this.ToAbsolutePath(fPath)),
                                    disabled: this.isFileDisabled(node)
                                });
                            }
                        });
                    }
                    obj.fileGroups.push(fGroup);
                });
            }

            result.push(obj);
        }

        return result;
    }

    private setOption(targetOptionObj: any, prj: AbstractProject) {

        const target51 = targetOptionObj.Target51;
        const options = prj.GetConfiguration().compileConfigModel
            .getOptions(prj.getEideDir().path, prj.GetConfiguration().config);

        if (target51.Target51Misc) {
            switch (options.global['ram-mode']) {
                case 'SMALL':
                    target51.Target51Misc.MemoryModel = '0';
                    break;
                case 'COMPACT':
                    target51.Target51Misc.MemoryModel = '1';
                    break;
                case 'LARGE':
                    target51.Target51Misc.MemoryModel = '2';
                    break;
                default:
                    target51.Target51Misc.MemoryModel = '2';
                    break;
            }
            switch (options.global['rom-mode']) {
                case 'SMALL':
                    target51.Target51Misc.RomSize = '0';
                    break;
                case 'COMPACT':
                    target51.Target51Misc.RomSize = '1';
                    break;
                case 'LARGE':
                    target51.Target51Misc.RomSize = '2';
                    break;
                default:
                    target51.Target51Misc.RomSize = '2';
                    break;
            }
        }

        try {
            if (target51.C51) {
                target51.C51.SizeSpeed = options["c/cpp-compiler"]['optimization-type'] === 'SIZE' ? '0' : '1';
                target51.C51.Optimize = options["c/cpp-compiler"]['optimization-level']?.replace('level-', '') || '8';
            }
        } catch (error) {
            GlobalEvent.emit('msg', ExceptionToMessage(error, 'Warning'));
            GlobalEvent.emit('msg', {
                type: 'Warning',
                contentType: 'string',
                content: '编译配置导出失败！请在 Keil 中手动完成设置'
            });
        }
    }

    SetKeilXml(prj: AbstractProject, fileGroups: FileGroup[], deviceInfo?: CurrentDevice): void {

        const prjConfig: ProjectConfiguration<any> = prj.GetConfiguration();
        const target = this.doc.Project.Targets.Target[0];
        const mergedDep = prjConfig.GetAllMergeDep([
            `${ProjectConfiguration.BUILD_IN_GROUP_NAME}.${DependenceManager.toolchainDepName}`
        ]);

        // get all include paths
        mergedDep.incList = ArrayDelRepetition(mergedDep.incList.concat(
            prj.getToolchain().getDefaultIncludeList(),
            prj.getSourceIncludeList()
        ));

        let devName: string;
        let vendor: string;

        if (deviceInfo !== undefined) {
            const dev = prj.GetPackManager().getCurrentDevInfo(deviceInfo);
            devName = dev?.name || 'Unknown';
            vendor = deviceInfo.packInfo.vendor;
        } else {
            devName = 'AT89C52';
            vendor = 'Atmel';
        }

        target.TargetName = prjConfig.config.name;
        target.TargetOption.TargetCommonOption.Device = devName;
        target.TargetOption.TargetCommonOption.Vendor = vendor;

        const outFolder = NodePath.normalize(prjConfig.config.outDir);
        target.TargetOption.TargetCommonOption.OutputDirectory = `.\\${outFolder}\\Keil\\`;
        target.TargetOption.TargetCommonOption.ListingPath = `.\\${outFolder}\\Keil\\`;
        target.TargetOption.TargetCommonOption.OutputName = target.TargetName;

        target.TargetOption.Target51.C51.VariousControls.IncludePath = mergedDep.incList.map<string>(inc => {

            return prj.ToRelativePath(inc) || inc;

        }).filter(v => { return v !== undefined; }).join(File.delimiter);

        target.TargetOption.Target51.C51.VariousControls.Define = mergedDep.defineList.join(",");

        this.setOption(target.TargetOption, prj);

        const nGroups: any[] = [];

        fileGroups.forEach(group => {
            const files: any[] = [];
            const gElement = { GroupName: group.name, Files: { File: files } };

            this.setGroupDisableFlag(gElement, group.disabled);

            nGroups.push(gElement);

            group.files.forEach(_f => {

                const fileElement = {
                    FileName: _f.file.name,
                    FileType: this.JudgeFileType(_f.file).toString(),
                    FilePath: prj.ToRelativePath(_f.file.path) || _f.file.path
                };

                this.setFileDisableFlag(fileElement, _f.disabled);

                if (fileElement.FilePath !== undefined) {
                    gElement.Files.File.push(fileElement);
                }
            });
        });

        if (target.Groups === undefined) {
            target.Groups = { Group: nGroups };
        } else {
            target.Groups.Group = nGroups;
        }
    }
}

class KeilSettingMapper {

    private static readonly mapName = 'option.mapper.json';
    private mapper: any;
    private toolVersion: ToolchainName;

    constructor(toolVersion: ToolchainName) {

        if (toolVersion === 'None') {
            throw new Error('toolVersion can not be \'None\'');
        }

        this.toolVersion = toolVersion;
        const mapperFile = new File(ResManager.GetInstance().GetAppDataDir().path
            + File.sep + KeilSettingMapper.mapName);

        if (!mapperFile.IsFile()) {
            throw new Error('Not found file, [path] \'' + mapperFile.path + '\'');
        }

        try {
            this.mapper = JSON.parse(mapperFile.Read());
        } catch (error) {
            throw error;
        }
    }

    toKeil(TargetOption: any, groupName: string, key: string, val: string | boolean): void {
        const domainObj = this.mapper.groups[this.toolVersion];
        const objGroup = domainObj[groupName];
        const option = objGroup.properties[key];
        if (option) {
            const value = option.enum[typeof val === 'boolean' ? val.toString() : val];
            if (value !== undefined) {
                const keilCategory = TargetOption[this.mapper.keilName];
                keilCategory[objGroup.keilName][option.keilName] = value;
            }
        }
    }

    fromKeil(TargetOption: any, groupName: string, key: string): string | boolean | undefined {

        const domainObj = this.mapper.groups[this.toolVersion];
        const objGroup = domainObj[groupName];
        const option = objGroup.properties[key];

        if (option) {
            const keilCategory = TargetOption[this.mapper.keilName];
            const keilGroup = keilCategory[objGroup.keilName];

            if (keilGroup && keilGroup[option.keilName] !== undefined) {
                const keilValue = keilGroup[option.keilName];
                for (const opKey in option.enum) {
                    if (option.enum[opKey] === keilValue) {
                        if (opKey === 'true') {
                            return true;
                        } else if (opKey === 'false') {
                            return false;
                        }
                        return opKey;
                    }
                }

                if (option.defaultKey !== undefined) {
                    return option.defaultKey;
                }

                if (option.enum['false'] !== undefined) {
                    return false;
                }
            }
        }

        return undefined;
    }

    getGroupList(): string[] {
        const res: string[] = [];
        for (const key in this.mapper.groups[this.toolVersion]) {
            res.push(key);
        }
        return res;
    }

    getOptionKeyList(groupName: string): string[] {
        const res: string[] = [];
        const group = this.mapper.groups[this.toolVersion][groupName];
        if (group) {
            for (const key in group.properties) {
                res.push(key);
            }
        }
        return res;
    }
}

export interface KeilARMOption extends ArmBaseCompileData, ICommonOptions {
}

class ARMParser extends KeilParser<KeilARMOption> {

    TYPE_TAG: ProjectType = 'ARM';

    constructor(f: File) {
        super(f);
    }

    private getOption(targetOptionObj: any, option: KeilARMOption) {

        const armAdsObj = targetOptionObj.TargetArmAds;
        try {

            if (!armAdsObj) {
                throw Error('Not found Keil Option: \'TargetArmAds\'');
            }

            option.optionsGroup = Object.create(null);

            // AC5, AC6 setting
            for (let i = 5; i < 7; i++) {

                const toolV = <ToolchainName>('AC' + i.toString());
                const keilMapper = new KeilSettingMapper(toolV);
                option.optionsGroup[toolV] = Object.create(null);

                const optionData: any = option.optionsGroup[toolV];
                for (const groupName of keilMapper.getGroupList()) {
                    if (optionData[groupName] === undefined) {
                        optionData[groupName] = Object.create(null);
                    }
                    for (const opKey of keilMapper.getOptionKeyList(groupName)) {
                        const val = keilMapper.fromKeil(targetOptionObj, groupName, opKey);
                        if (val !== undefined && val !== false) {
                            optionData[groupName][opKey] = val;
                        }
                    }
                }
            }

            if (armAdsObj.LDads) {
                const LDads = armAdsObj.LDads;
                option.useCustomScatterFile = LDads.umfTarg !== '1';
                if (LDads.ScatterFile) {
                    if (LDads.ScatterFile.charAt(0) === '.') {
                        option.scatterFilePath = this._file.dir + File.sep + LDads.ScatterFile;
                    } else {
                        option.scatterFilePath = LDads.ScatterFile;
                    }
                }
            }

            const info = armAdsObj.ArmAdsMisc;
            if (info) {

                // init cpu type
                option.cpuType = info.AdsCpuType;
                if (option.cpuType) {
                    option.cpuType = option.cpuType.replace(/"/g, '');
                }

                // init fpu type
                switch (parseInt(info.RvdsVP)) {
                    case 1: // No use
                        option.floatingPointHardware = 'none';
                        break;
                    case 2: // single
                        option.floatingPointHardware = 'single';
                        break;
                    case 3: // double
                        option.floatingPointHardware = 'double';
                        break;
                    default:
                        option.floatingPointHardware = 'none';
                        break;
                }

                const memInfo: ARMStorageLayout = { RAM: [], ROM: [] };
                option.storageLayout = memInfo;

                for (let i = 0; i < 5; i++) {
                    memInfo.RAM.push({
                        tag: i < 3 ? 'RAM' : 'IRAM',
                        id: i < 3 ? (i + 1) : (i - 2),
                        mem: {
                            startAddr: '0x00000000',
                            size: '0x00000000'
                        },
                        isChecked: false,
                        noInit: false
                    });
                    memInfo.ROM.push({
                        tag: i < 3 ? 'ROM' : 'IROM',
                        id: i < 3 ? (i + 1) : (i - 2),
                        mem: {
                            startAddr: '0x00000000',
                            size: '0x00000000'
                        },
                        isChecked: false,
                        isStartup: false
                    });
                }

                // default startUp index: 3 (2^3)
                const index = Math.log2(parseInt(info.StupSel));
                memInfo.ROM[index].isStartup = true;

                memInfo.RAM[0].noInit = info.NoZi1 !== '0';
                memInfo.RAM[1].noInit = info.NoZi2 !== '0';
                memInfo.RAM[2].noInit = info.NoZi3 !== '0';
                memInfo.RAM[3].noInit = info.NoZi4 !== '0';
                memInfo.RAM[4].noInit = info.NoZi5 !== '0';

                memInfo.RAM[0].isChecked = info.Ra1Chk !== '0';
                memInfo.RAM[1].isChecked = info.Ra2Chk !== '0';
                memInfo.RAM[2].isChecked = info.Ra3Chk !== '0';
                memInfo.RAM[3].isChecked = info.Im1Chk !== '0';
                memInfo.RAM[4].isChecked = info.Im2Chk !== '0';

                memInfo.ROM[0].isChecked = info.Ro1Chk !== '0';
                memInfo.ROM[1].isChecked = info.Ro2Chk !== '0';
                memInfo.ROM[2].isChecked = info.Ro3Chk !== '0';
                memInfo.ROM[3].isChecked = info.Ir1Chk !== '0';
                memInfo.ROM[4].isChecked = info.Ir2Chk !== '0';

                const chipData = info.OnChipMemories;

                //========================= ROM ==============================
                memInfo.ROM[0].mem.startAddr = chipData.OCR_RVCT1.StartAddress;
                memInfo.ROM[0].mem.size = chipData.OCR_RVCT1.Size;

                memInfo.ROM[1].mem.startAddr = chipData.OCR_RVCT2.StartAddress;
                memInfo.ROM[1].mem.size = chipData.OCR_RVCT2.Size;

                memInfo.ROM[2].mem.startAddr = chipData.OCR_RVCT3.StartAddress;
                memInfo.ROM[2].mem.size = chipData.OCR_RVCT3.Size;

                memInfo.ROM[3].mem.startAddr = chipData.OCR_RVCT4.StartAddress;
                memInfo.ROM[3].mem.size = chipData.OCR_RVCT4.Size;

                memInfo.ROM[4].mem.startAddr = chipData.OCR_RVCT5.StartAddress;
                memInfo.ROM[4].mem.size = chipData.OCR_RVCT5.Size;

                //=========================== RAM ===========================
                memInfo.RAM[0].mem.startAddr = chipData.OCR_RVCT6.StartAddress;
                memInfo.RAM[0].mem.size = chipData.OCR_RVCT6.Size;

                memInfo.RAM[1].mem.startAddr = chipData.OCR_RVCT7.StartAddress;
                memInfo.RAM[1].mem.size = chipData.OCR_RVCT7.Size;

                memInfo.RAM[2].mem.startAddr = chipData.OCR_RVCT8.StartAddress;
                memInfo.RAM[2].mem.size = chipData.OCR_RVCT8.Size;

                memInfo.RAM[3].mem.startAddr = chipData.OCR_RVCT9.StartAddress;
                memInfo.RAM[3].mem.size = chipData.OCR_RVCT9.Size;

                memInfo.RAM[4].mem.startAddr = chipData.OCR_RVCT10.StartAddress;
                memInfo.RAM[4].mem.size = chipData.OCR_RVCT10.Size;
            }
        } catch (error) {
            GlobalEvent.emit('msg', ExceptionToMessage(error, 'Warning'));
            GlobalEvent.emit('msg', {
                type: 'Warning',
                contentType: 'string',
                content: 'Import compile options failed！Please complete the setup manually'
            });
        }
    }

    ParseData(): KeilParserResult<KeilARMOption>[] {

        const result: KeilParserResult<KeilARMOption>[] = [];

        /* parse target */

        for (const target of this.doc.Project.Targets.Target) {

            const obj = <KeilParserResult<KeilARMOption>>Object.create(null);

            obj.name = target.TargetName;

            obj.type = this.TYPE_TAG;

            obj.device = target.TargetOption.TargetCommonOption.Device;

            obj.vendor = target.TargetOption.TargetCommonOption.Vendor;

            obj.incList = this.SplitPathSeparator(
                target.TargetOption.TargetArmAds.Cads.VariousControls.IncludePath, new RegExp(File.delimiter + '\\s*'))
                .map<string>((path) => { return this.ToAbsolutePath(path); });

            obj.defineList = this.parseMacroString(target.TargetOption.TargetArmAds.Cads.VariousControls.Define);

            obj.compileOption = Object.create(null);
            obj.compileOption.toolchain = target.uAC6 === '1' ? 'AC6' : 'AC5';
            this.getOption(target.TargetOption, obj.compileOption);

            const groups = target.Groups;
            obj.fileGroups = [];

            if (groups !== undefined && groups.Group !== undefined) {

                groups.Group.forEach((group: { GroupName: string, Files: any[] }) => {
                    const fGroup = <FileGroup>{ name: '', files: [] };

                    fGroup.name = this.FixGroupName(group.GroupName);
                    fGroup.disabled = this.isGroupDisabled(group);

                    if (group.Files && group.Files.length > 0) {

                        // combine list
                        group.Files.slice(1).forEach((FILE) => {
                            group.Files[0].File = group.Files[0].File.concat(FILE.File);
                        });

                        group.Files[0].File.forEach((node: { FileName: string, FileType: string, FilePath: string }) => {
                            const fPath = node.FilePath;
                            if (fPath !== undefined) {
                                fGroup.files.push({
                                    file: new File(this.ToAbsolutePath(fPath)),
                                    disabled: this.isFileDisabled(node)
                                });
                            }
                        });
                    }

                    obj.fileGroups.push(fGroup);
                });
            }

            result.push(obj);
        }

        /* parse RTE components */

        const RTE = this.doc.Project.RTE;
        const rte_deps: KeilRteDependence[] = [];
        if (RTE && RTE.files) {

            for (const fGroups of RTE.files) {
                if (fGroups.file == undefined) { continue; }
                for (const fileInf of fGroups.file) {
                    const dep: KeilRteDependence = { path: fileInf.$name };
                    dep.category = fileInf.$category;
                    if (fileInf.component) { dep.class = fileInf.component.$Cclass; }
                    if (fileInf.package &&
                        fileInf.package.$name &&
                        fileInf.package.$vendor &&
                        fileInf.package.$version) {
                        dep.packPath = [fileInf.package.$vendor, fileInf.package.$name, fileInf.package.$version].join(File.sep);
                    }
                    if (Array.isArray(fileInf.instance) && fileInf.instance.length > 0) {
                        dep.instance = fileInf.instance.map((item: any) => this.ToAbsolutePath(item.toString()));
                    }
                    rte_deps.push(dep);
                }
            }

            result.forEach((target) => {
                target.rte_deps = rte_deps.concat();
            });
        }

        return result;
    }

    private setOption(targetOptionObj: any, prj: AbstractProject) {

        const armAdsObj = targetOptionObj.TargetArmAds;
        const prjConfig = <ProjectConfiguration<ArmBaseCompileData>>prj.GetConfiguration();
        const config = prjConfig.config.compileConfig;

        const eidePath = prj.getEideDir().path;
        const compileModel = <ArmBaseCompileConfigModel>prjConfig.compileConfigModel;

        try {
            if (!armAdsObj) {
                throw Error('Not found Keil Option: \'TargetArmAds\'');
            }

            // set other toolchain options
            for (let i = 5; i < 7; i++) {
                const toolName = <ToolchainName>('AC' + i.toString());
                if (toolName !== prj.getToolchain().name) {
                    const mapper = new KeilSettingMapper(toolName);
                    const toolchain = ToolchainManager.getInstance().getToolchain('ARM', toolName);
                    const options: any = compileModel.getOptions(eidePath, prjConfig.config);
                    for (const groupName of mapper.getGroupList()) {
                        for (const opKey in options[groupName]) {
                            mapper.toKeil(targetOptionObj, groupName, opKey, options[groupName][opKey]);
                        }
                    }
                }
            }

            //set current
            const toolchain = prj.getToolchain();
            const mapper = new KeilSettingMapper(toolchain.name);
            const options: any = compileModel.getOptions(eidePath, prjConfig.config);
            for (const groupName of mapper.getGroupList()) {
                for (const opKey in options[groupName]) {
                    mapper.toKeil(targetOptionObj, groupName, opKey, options[groupName][opKey]);
                }
            }

            if (armAdsObj.LDads) {
                const LDads = armAdsObj.LDads;
                LDads.umfTarg = config.useCustomScatterFile ? '0' : '1';
                const absPath = prj.ToAbsolutePath(config.scatterFilePath);
                LDads.ScatterFile = this.ToRelativePath(absPath);
            }

            const info = armAdsObj.ArmAdsMisc;
            if (info) {

                // set cpu type
                info.AdsCpuType = '"' + config.cpuType + '"';

                // set fpu type
                switch (config.floatingPointHardware) {
                    case 'single': // single
                        info.RvdsVP = 2;
                        break;
                    case 'double': // double
                        info.RvdsVP = 3;
                        break;
                    default: // No use
                        info.RvdsVP = 1;
                        break;
                }

                // set mem info
                const memInfo: ARMStorageLayout = config.storageLayout;
                // default startUp index: 3 (2^3)
                const index = memInfo.ROM.findIndex((rom) => { return rom.isStartup; });
                info.StupSel = Math.pow(2, index !== -1 ? index : 3);

                //=========================== RAM Chk ===========================
                // RAM Chk init
                for (let i = 1; i < 6; i++) {
                    if (i < 4) {
                        info['Ra' + i + 'Chk'] = '0';
                    } else {
                        info['Im' + (i - 3) + 'Chk'] = '0';
                    }
                }

                // NoZix RAM Chk
                memInfo.RAM.forEach((ram, index) => {
                    const id = index + 1;
                    info['NoZi' + id] = ram.noInit ? '1' : '0';
                    if (id < 4) {
                        info['Ra' + id + 'Chk'] = ram.isChecked ? '1' : '0';
                    } else {
                        info['Im' + (id - 3) + 'Chk'] = ram.isChecked ? '1' : '0';
                    }
                });

                //=========================== ROM Chk ===========================
                // ROM Chk init
                for (let i = 1; i < 6; i++) {
                    if (i < 4) {
                        info['Ro' + i + 'Chk'] = '0';
                    } else {
                        info['Ir' + (i - 3) + 'Chk'] = '0';
                    }
                }

                // ROM Chk
                memInfo.ROM.forEach((rom, index) => {
                    const id = index + 1;
                    if (id < 4) {
                        info['Ro' + id + 'Chk'] = rom.isChecked ? '1' : '0';
                    } else {
                        info['Ir' + (id - 3) + 'Chk'] = rom.isChecked ? '1' : '0';
                    }
                });

                const chipData = info.OnChipMemories;

                // ROM init
                for (let i = 1; i < 11; i++) {
                    chipData['OCR_RVCT' + i].StartAddress = '0x0';
                    chipData['OCR_RVCT' + i].Size = '0x0';
                }

                //=========================== ROM ===========================
                memInfo.ROM.forEach((rom, index) => {
                    const id = index + 1;
                    chipData['OCR_RVCT' + id].StartAddress = rom.mem.startAddr;
                    chipData['OCR_RVCT' + id].Size = rom.mem.size;
                });

                //=========================== RAM ===========================
                memInfo.RAM.forEach((ram, index) => {
                    const id = index + 6;
                    chipData['OCR_RVCT' + id].StartAddress = ram.mem.startAddr;
                    chipData['OCR_RVCT' + id].Size = ram.mem.size;
                });
            }
        } catch (error) {
            GlobalEvent.emit('msg', ExceptionToMessage(error, 'Warning'));
            GlobalEvent.emit('msg', {
                type: 'Warning',
                contentType: 'string',
                content: 'Export compile options failed！Please complete the setup manually'
            });
        }
    }

    SetKeilXml(prj: AbstractProject, fileGroups: FileGroup[], deviceInfo?: CurrentDevice): void {

        const prjConfig: ProjectConfiguration<any> = prj.GetConfiguration();
        const target = this.doc.Project.Targets.Target[0];
        const mergedDep = prjConfig.GetAllMergeDep([
            `${ProjectConfiguration.BUILD_IN_GROUP_NAME}.${DependenceManager.toolchainDepName}`
        ]);

        // get all include paths
        mergedDep.incList = ArrayDelRepetition(mergedDep.incList.concat(
            prj.getToolchain().getDefaultIncludeList(),
            prj.getSourceIncludeList()
        ));

        let devName: string = '';
        let vendor: string = '';

        if (deviceInfo !== undefined) {
            const family = deviceInfo.packInfo.familyList[deviceInfo.familyIndex];
            const dev = prj.GetPackManager().getCurrentDevInfo(deviceInfo);
            devName = dev?.name || 'Unknown';
            if (family.vendor) {
                vendor = family.vendor.replace(/:.+$/i, '');
            }
        }

        target.TargetName = prjConfig.config.name;
        target.TargetOption.TargetCommonOption.Device = devName;
        target.TargetOption.TargetCommonOption.Vendor = vendor;

        const outFolder = NodePath.normalize(prjConfig.config.outDir);
        target.TargetOption.TargetCommonOption.OutputDirectory = `.\\${outFolder}\\Keil\\`;
        target.TargetOption.TargetCommonOption.ListingPath = `.\\${outFolder}\\Keil\\`;
        target.TargetOption.TargetCommonOption.OutputName = target.TargetName;

        target.TargetOption.TargetArmAds.Cads.VariousControls.IncludePath = mergedDep.incList.map<string>(inc => {

            return prj.ToRelativePath(inc) || inc;

        }).filter(v => { return v !== undefined; }).join(File.delimiter);

        target.TargetOption.TargetArmAds.Cads.VariousControls.Define = mergedDep.defineList.join(","); // C/CPP
        target.TargetOption.TargetArmAds.Aads.VariousControls.Define = mergedDep.defineList.join(","); // ASM

        this.setOption(target.TargetOption, prj);

        const nGroups: any[] = [];

        fileGroups.forEach(group => {

            const gElement = { GroupName: group.name, Files: { File: <any[]>[] } };

            this.setGroupDisableFlag(gElement, group.disabled);

            nGroups.push(gElement);

            group.files.forEach(_f => {

                const fileElement = {
                    FileName: _f.file.name,
                    FileType: this.JudgeFileType(_f.file).toString(),
                    FilePath: prj.ToRelativePath(_f.file.path) || _f.file.path
                };

                this.setFileDisableFlag(fileElement, _f.disabled);

                if (fileElement.FilePath !== undefined) {
                    gElement.Files.File.push(fileElement);
                }
            });
        });

        if (target.Groups === undefined) {
            target.Groups = { Group: nGroups };
        } else {
            target.Groups.Group = nGroups;
        }
    }
}

/*let info = this.doc.Project.Targets.Target[0].TargetOption.TargetArmAds.ArmAdsMisc;

        default startUp index: 3
        memScatter.startUpIndex = 3;
        let index = Number.parseInt(info.StupSel);
        memScatter.startUpIndex = Math.log2(index);

        memScatter.ramList[0].noInit = info.NoZi1 !== '0';
        memScatter.ramList[1].noInit = info.NoZi2 !== '0';
        memScatter.ramList[2].noInit = info.NoZi3 !== '0';
        memScatter.ramList[3].noInit = info.NoZi4 !== '0';
        memScatter.ramList[4].noInit = info.NoZi5 !== '0';

        memScatter.romList[0].selected = info.Ro1Chk !== '0';
        memScatter.romList[1].selected = info.Ro2Chk !== '0';
        memScatter.romList[2].selected = info.Ro3Chk !== '0';
        memScatter.romList[3].selected = info.Ir1Chk !== '0';
        memScatter.romList[4].selected = info.Ir2Chk !== '0';
        memScatter.romList[3].selected = true;

        memScatter.ramList[0].selected = info.Ra1Chk !== '0';
        memScatter.ramList[1].selected = info.Ra2Chk !== '0';
        memScatter.ramList[2].selected = info.Ra3Chk !== '0';
        memScatter.ramList[3].selected = info.Im1Chk !== '0';
        memScatter.ramList[4].selected = info.Im2Chk !== '0';
        memScatter.ramList[3].selected = true;

        let chipData = info.OnChipMemories;

        memScatter.romList[0].memInfo.startAddr = this.FillHexNumber(chipData.OCR_RVCT1.StartAddress);
        memScatter.romList[0].memInfo.size = this.FillHexNumber(chipData.OCR_RVCT1.Size);

        memScatter.romList[1].memInfo.startAddr = this.FillHexNumber(chipData.OCR_RVCT2.StartAddress);
        memScatter.romList[1].memInfo.size = this.FillHexNumber(chipData.OCR_RVCT2.Size);

        memScatter.romList[2].memInfo.startAddr = this.FillHexNumber(chipData.OCR_RVCT3.StartAddress);
        memScatter.romList[2].memInfo.size = this.FillHexNumber(chipData.OCR_RVCT3.Size);

        memScatter.romList[3].memInfo.startAddr = this.FillHexNumber(chipData.OCR_RVCT4.StartAddress);
        memScatter.romList[3].memInfo.size = this.FillHexNumber(chipData.OCR_RVCT4.Size);

        memScatter.romList[4].memInfo.startAddr = this.FillHexNumber(chipData.OCR_RVCT5.StartAddress);
        memScatter.romList[4].memInfo.size = this.FillHexNumber(chipData.OCR_RVCT5.Size);

        memScatter.romList[3].memInfo.startAddr = this.FillHexNumber(mem.rom.startAddr);
        memScatter.romList[3].memInfo.size = this.FillHexNumber(mem.rom.size);

        //------------------------------------Ram-----------------------------------------------
        memScatter.ramList[0].memInfo.startAddr = this.FillHexNumber(chipData.OCR_RVCT6.StartAddress);
        memScatter.ramList[0].memInfo.size = this.FillHexNumber(chipData.OCR_RVCT6.Size);

        memScatter.ramList[1].memInfo.startAddr = this.FillHexNumber(chipData.OCR_RVCT7.StartAddress);
        memScatter.ramList[1].memInfo.size = this.FillHexNumber(chipData.OCR_RVCT7.Size);

        memScatter.ramList[2].memInfo.startAddr = this.FillHexNumber(chipData.OCR_RVCT8.StartAddress);
        memScatter.ramList[2].memInfo.size = this.FillHexNumber(chipData.OCR_RVCT8.Size);

        memScatter.ramList[3].memInfo.startAddr = this.FillHexNumber(chipData.OCR_RVCT9.StartAddress);
        memScatter.ramList[3].memInfo.size = this.FillHexNumber(chipData.OCR_RVCT9.Size);

        memScatter.ramList[4].memInfo.startAddr = this.FillHexNumber(chipData.OCR_RVCT10.StartAddress);
        memScatter.ramList[4].memInfo.size = this.FillHexNumber(chipData.OCR_RVCT10.Size);

        memScatter.ramList[3].memInfo.startAddr = this.FillHexNumber(mem.ram.startAddr);
        memScatter.ramList[3].memInfo.size = this.FillHexNumber(mem.ram.size);*/

