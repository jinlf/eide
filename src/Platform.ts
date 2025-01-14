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

import * as child_process from 'child_process';
import * as NodePath from 'path';
import * as os from 'os';
import * as fs from 'fs';

import { File } from '../lib/node-utility/File';
import { FileWatcher } from '../lib/node-utility/FileWatcher';

export const UUID_NULL = 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF';

let uuid: string | undefined;

let osPlatform: NodeJS.Platform = os.platform();

let linuxOsId: string | undefined;

const devNull: string = os.platform() == 'win32' ? 'nul' : '/dev/null';

export function getLinuxOsId(): string | undefined {
    if (linuxOsId) return linuxOsId;
    if (osPlatform == 'linux') {
        try {
            const infList = child_process.execSync(`cat /etc/os-release`).toString().trim().split(/\r\n|\n/);
            for (const str of infList) {
                if (str.startsWith('ID=')) {
                    linuxOsId = str.replace('ID=', '').trim();
                    return linuxOsId;
                }
            }
        } catch (error) {
            // nothing todo
        }
    }
}

export function osType(): NodeJS.Platform {
    return osPlatform;
}

export function osGetNullDev(): string {
    return devNull;
}

export function createSafetyFileWatcher(_file: File, _recursive: boolean = false) {
    if (osPlatform != 'win32' &&
        osPlatform != 'darwin') {
        _recursive = false;
    }
    return new FileWatcher(_file, _recursive);
}

export function exeSuffix(): string {
    if (osPlatform == 'win32') {
        return '.exe';
    } else {
        return '';
    }
}

export function GetUUID(): string {

    if (uuid) {
        return uuid;
    }

    try {
        if (osPlatform == 'win32') {
            const buf: string = child_process.execSync('wmic csproduct get UUID', { windowsHide: true, encoding: 'utf8' }).toString();
            const list = buf.match(/[a-zA-Z0-9]{8}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{12}/);
            uuid = list ? list[0] : UUID_NULL;
        } else {
            uuid = child_process.execSync(`cat /proc/sys/kernel/random/uuid`).toString().trim();
        }
    } catch (error) {
        uuid = UUID_NULL;
    }

    return uuid;
}

export function GetLocalCodePage(): string | undefined {
    try {
        if (osPlatform == 'win32') {
            const buf: string = child_process.execSync('chcp', { windowsHide: true, encoding: 'utf8' }).toString();
            const list = buf.match(/[0-9]+/);
            return list ? list[0].trim() : undefined;
        } else {
            // for linux, use default: en_US.UTF-8
            return undefined;
        }
    } catch (error) {
        return undefined;
    }
}

export function DeleteDir(dir: File): string {
    try {
        if (osPlatform == 'win32') {
            return child_process.execSync(`rmdir /S /Q "${dir.path}"`, { encoding: 'ascii' });
        } else {
            return child_process.execSync(`rm -rf "${dir.path}"`, { encoding: 'utf8' });
        }
    } catch (error) {
        return JSON.stringify(error);
    }
}

export function DeleteAllChildren(dir: File): string {
    try {
        if (osPlatform == 'win32') {
            if (['c:\\', 'c:'].includes(dir.path.toLowerCase())) return 'DeleteAllChildren failed !';
            return child_process.execSync('powershell Remove-Item \'' + dir.path + '\\*\' -Recurse -Force -ErrorAction:Continue', { encoding: 'utf8' });
        } else {
            if (['/', '/home'].includes(dir.path)) return 'DeleteAllChildren failed !';
            return child_process.execSync(`rm -rf "${dir.path}/*"`, { encoding: 'utf8' });
        }
    } catch (error) {
        return JSON.stringify(error);
    }
}

export function find(fileName: string): string | undefined {
    try {
        if (osPlatform == 'win32') {
            const nameList = child_process.execSync(`where "${fileName}"`,
                { windowsHide: true, encoding: 'ascii', shell: 'cmd' }).split(/\r\n|\n/);
            if (nameList.length > 0) {
                const path = nameList[0].replace(/"/g, '');
                if (File.isAbsolute(path)) {
                    return path;
                }
            }
        } else {
            const res = child_process.execSync(`which ${fileName}`).toString().trim();
            return res.replace(/"'/g, '');
        }
    } catch (error) {
        return undefined;
    }
}

export function appendToSysEnv(env: NodeJS.ProcessEnv, paths: string[]) {

    const pName = os.platform() == 'win32' ? 'Path' : 'PATH';
    const sep = os.platform() == 'win32' ? ';' : ':';

    if (env[pName]) {
        const pList = [<string>env[pName]].concat(paths);
        env[pName] = pList.join(sep);
    }
}

export function prependToSysEnv(env: NodeJS.ProcessEnv, paths: string[]) {

    const pList = paths.concat();
    const pName = os.platform() == 'win32' ? 'Path' : 'PATH';
    const sep = os.platform() == 'win32' ? ';' : ':';

    if (env[pName]) {
        pList.push(<string>env[pName]);
    }

    env[pName] = pList.join(sep);
}

export function concatSystemEnvPath(paths: string[], defEnv?: NodeJS.ProcessEnv): { [key: string]: string } {

    const env = JSON.parse(JSON.stringify(defEnv || process.env || {}));

    if (os.platform() == 'win32') {
        env['Path'] = env['Path'] ? `${paths.join(';')};${env['Path']}` : paths.join(';');
    } else {
        env['PATH'] = env['PATH'] ? `${paths.join(':')}:${env['PATH']}` : paths.join(':');
    }

    return env;
}

export function kill(pid: number): boolean {
    try {
        if (os.platform() == 'win32') {
            child_process.execSync(`taskkill /PID ${pid} /T /F`);
        } else {
            child_process.execSync(`kill -9 ${pid}`);
        }
    } catch (error) {
        return false;
    }

    return true;
}

export function realpathSync(path: string): string {
    try {
        return fs.realpathSync(path);
    } catch (error) {
        return path;
    }
}

/*
export function getWindowsMainVersion(): number | undefined {
    try {
        const lines = child_process.execSync(`ver`,
            { windowsHide: true, encoding: 'ascii', shell: 'cmd' }).split(/\r\n|\n/);
        for (let line of lines) {
            const mRes = /(\d+)[\d\.]+\]\s*$/.exec(line);
            if (mRes && mRes.length > 1) {
                const version = parseInt(mRes[1]);
                return version || undefined;
            }
        }
    } catch (error) {
        return undefined;
    }
}
 */
