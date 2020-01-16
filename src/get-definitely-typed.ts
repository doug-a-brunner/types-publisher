import appInsights = require("applicationinsights");
import assert = require("assert");
import { ensureDir, pathExistsSync, readdirSync, statSync } from "fs-extra";
import https = require("https");
import tarStream = require("tar-stream");
import * as yargs from "yargs";
import * as zlib from "zlib";

import { Options } from "./lib/common";
import { dataDirPath, definitelyTypedZipUrl } from "./lib/settings";
import { readFileSync, readJsonSync, stringOfStream } from "./util/io";
import { LoggerWithErrors, loggerWithErrors } from "./util/logging";
import { assertDefined, assertSorted, exec, joinPaths, logUncaughtErrors, withoutStart } from "./util/util";

/**
 * Readonly filesystem.
 * Paths provided to these methods should be relative to the FS object's root but not start with '/' or './'.
 */
export interface FS {
    /**
     * Alphabetically sorted list of files and subdirectories.
     * If dirPath is missing, reads the root.
     */
    readdir(dirPath?: string): ReadonlyArray<string>;
    readJson(path: string): unknown;
    readFile(path: string): string;
    isDirectory(dirPath: string): boolean;
    exists(path: string): boolean;
    /** FileSystem rooted at a child directory. */
    subDir(path: string): FS;
    /** Representation of current location, for debugging. */
    debugPath(): string;
}

if (!module.parent) {
    if (process.env.APPINSIGHTS_INSTRUMENTATIONKEY) {
        appInsights.setup();
        appInsights.start();
    }
    const dry = !!yargs.argv.dry;
    console.log("gettingDefinitelyTyped: " + (dry ? "from github" : "locally"));
    logUncaughtErrors(async () => {
        const dt = await getDefinitelyTyped(dry ? Options.azure : Options.defaults, loggerWithErrors()[0]);
        assert(dt.exists("types"));
        assert(!(dt.exists("buncho")));
    });
}

export async function getDefinitelyTyped(options: Options, log: LoggerWithErrors): Promise<FS> {
    if (options.definitelyTypedPath === undefined) {
        log.info("Downloading Definitely Typed ...");
        await ensureDir(dataDirPath);
        return downloadAndExtractFile(definitelyTypedZipUrl);
    } else {
        const { error, stderr, stdout } = await exec("git diff --name-only", options.definitelyTypedPath);
        if (error) { throw error; }
        if (stderr) { throw new Error(stderr); }
        if (stdout) { throw new Error(`'git diff' should be empty. Following files changed:\n${stdout}`); }
        log.info(`Using local Definitely Typed at ${options.definitelyTypedPath}.`);
        return new DiskFS(`${options.definitelyTypedPath}/`);
    }
}

export function getLocallyInstalledDefinitelyTyped(path: string): FS {
    return new DiskFS(`${path}/`);
}

function downloadAndExtractFile(url: string): Promise<FS> {
    return new Promise<FS>((resolve, reject) => {
        const root = new Dir(undefined);
        function insertFile(path: string, content: string): void {
            const components = path.split("/");
            const baseName = assertDefined(components.pop());
            let dir = root;
            for (const component of components) {
                dir = dir.subdir(component);
            }
            dir.set(baseName, content);
        }

        https.get(url, response => {
            const extract = tarStream.extract();
            response.pipe(zlib.createGunzip()).pipe(extract);
            interface Header {
                readonly name: string;
                readonly type: "file" | "directory";
            }
            extract.on("entry", (header: Header, stream: NodeJS.ReadableStream, next: () => void) => {
                const name = assertDefined(withoutStart(header.name, "DefinitelyTyped-master/"));
                switch (header.type) {
                    case "file":
                        stringOfStream(stream, name).then(s => {
                            insertFile(name, s);
                            next();
                        }).catch(reject);
                        break;
                    case "directory":
                        next();
                        break;
                    default:
                        throw new Error(`Unexpected file system entry kind ${header.type}`);
                }
            });
            extract.on("error", reject);
            extract.on("finish", () => { resolve(new InMemoryDT(root.finish(), "")); });
        });
    });
}

interface ReadonlyDir extends ReadonlyMap<string, ReadonlyDir | string> {
    readonly parent: Dir | undefined;
}

// Map entries are Dir for directory and string for file.
export class Dir extends Map<string, Dir | string> implements ReadonlyDir {
    constructor(readonly parent: Dir | undefined) { super(); }

    subdir(name: string): Dir {
        const x = this.get(name);
        if (x !== undefined) {
            if (typeof x === "string") {
                throw new Error(`File ${name} has same name as a directory?`);
            }
            return x;
        }
        const res = new Dir(this);
        this.set(name, res);
        return res;
    }

    finish(): Dir {
        const out = new Dir(this.parent);
        for (const key of Array.from(this.keys()).sort()) {
            const subDirOrFile = this.get(key)!;
            out.set(key, typeof subDirOrFile === "string" ? subDirOrFile : subDirOrFile.finish());
        }
        return out;
    }
}

export class InMemoryDT implements FS {
    /** pathToRoot is just for debugging */
    constructor(readonly curDir: ReadonlyDir, readonly pathToRoot: string) {}

    private tryGetEntry(path: string): ReadonlyDir | string | undefined {
        validatePath(path);
        if (path === "") {
            return this.curDir;
        }
        const components = path.split("/");
        const baseName = assertDefined(components.pop());
        let dir = this.curDir;
        for (const component of components) {
            const entry = component === ".." ? dir.parent : dir.get(component);
            if (entry === undefined) {
                return undefined;
            }
            if (!(entry instanceof Dir)) {
                throw new Error(`No file system entry at ${this.pathToRoot}/${path}. Siblings are: ${Array.from(dir.keys())}`);
            }
            dir = entry;
        }
        return dir.get(baseName);
    }

    private getEntry(path: string): ReadonlyDir | string {
        const entry = this.tryGetEntry(path);
        if (entry === undefined) { throw new Error(`No file system entry at ${this.pathToRoot}/${path}`); }
        return entry;
    }

    private getDir(dirPath: string): Dir {
        const res = this.getEntry(dirPath);
        if (!(res instanceof Dir)) {
            throw new Error(`${this.pathToRoot}/${dirPath} is a file, not a directory.`);
        }
        return res;
    }

    readFile(filePath: string): string {
        const res = this.getEntry(filePath);
        if (typeof res !== "string") {
            throw new Error(`${this.pathToRoot}/${filePath} is a directory, not a file.`);
        }
        return res;
    }

    readdir(dirPath?: string): ReadonlyArray<string> {
        return Array.from((dirPath === undefined ? this.curDir : this.getDir(dirPath)).keys());
    }

    readJson(path: string): unknown {
        return JSON.parse(this.readFile(path)) as unknown;
    }

    isDirectory(path: string): boolean {
        return typeof this.getEntry(path) !== "string";
    }

    exists(path: string): boolean {
        return this.tryGetEntry(path) !== undefined;
    }

    subDir(path: string): FS {
        return new InMemoryDT(this.getDir(path), joinPaths(this.pathToRoot, path));
    }

    debugPath(): string {
        return this.pathToRoot;
    }
}

class DiskFS implements FS {
    constructor(private readonly rootPrefix: string) {
        assert(rootPrefix.endsWith("/"));
    }

    private getPath(path: string | undefined): string {
        if (path === undefined) {
            return this.rootPrefix;
        } else {
            validatePath(path);
            return this.rootPrefix + path;
        }
    }

    readdir(dirPath?: string): ReadonlyArray<string> {
        return readdirSync(this.getPath(dirPath)).sort().filter(name => name !== ".DS_STORE");
    }

    isDirectory(dirPath: string): boolean {
        return statSync(this.getPath(dirPath)).isDirectory();
    }

    readJson(path: string): unknown {
        return readJsonSync(this.getPath(path));
    }

    readFile(path: string): string {
        return readFileSync(this.getPath(path));
    }

    exists(path: string): boolean {
        return pathExistsSync(this.getPath(path));
    }

    subDir(path: string): FS {
        return new DiskFS(`${this.rootPrefix}${path}/`);
    }

    debugPath(): string {
        return this.rootPrefix.slice(0, this.rootPrefix.length - 1); // remove trailing '/'
    }
}

/** FS only handles simple paths like `foo/bar` or `../foo`. No `./foo` or `/foo`. */
function validatePath(path: string): void {
    if (path.startsWith(".") && path !== ".editorconfig" && !path.startsWith("../")) {
        throw new Error(`${path}: filesystem doesn't support paths of the form './x'.`);
    } else if (path.startsWith("/")) {
        throw new Error(`${path}: filesystem doesn't support paths of the form '/xxx'.`);
    } else if (path.endsWith("/")) {
        throw new Error(`${path}: filesystem doesn't support paths of the form 'xxx/'.`);
    }
}
