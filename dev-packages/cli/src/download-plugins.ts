/********************************************************************************
 * Copyright (C) 2020 Ericsson and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

/* eslint-disable @typescript-eslint/no-explicit-any */

import fetch, { Response, RequestInit } from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyForUrl } from 'proxy-from-env';
import { promises as fs, createReadStream } from 'fs';
import * as mkdirp from 'mkdirp';
import * as path from 'path';
import * as process from 'process';
import * as stream from 'stream';
import * as decompress from 'decompress';
import * as temp from 'temp';
import { checkStream, fromStream } from 'ssri';
import { green, red, yellow } from 'colors/safe';

import { promisify } from 'util';
const mkdirpAsPromised = promisify<string, mkdirp.Made>(mkdirp);
const pipelineAsPromised = promisify(stream.pipeline);

temp.track();

/**
 * Available options when downloading.
 */
export interface DownloadPluginsOptions {
    /**
     * Determines if a plugin should be unpacked.
     * Defaults to `false`.
     */
    packed?: boolean;

    /**
     * Determines if failures while downloading plugins should be ignored.
     * Defaults to `false`.
     */
    ignoreErrors?: boolean;
}

/**
 * TODO
 */
interface PluginLock {
    /**
     * URL where to download this plugins
     */
    resolved?: string;
    /**
     * hash of the plugin data
     */
    integrity?: string;
}

interface PluginLockData { [key: string]: PluginLock };

export default async function downloadPlugins(options: DownloadPluginsOptions = {}): Promise<void> {

    // Collect the list of failures to be appended at the end of the script.
    const failures: string[] = [];

    const {
        packed = false,
        ignoreErrors = false,
    } = options;

    console.warn('--- downloading plugins ---');

    // Resolve the `package.json` at the current working directory.
    const pck = require(path.resolve(process.cwd(), 'package.json'));

    // Resolve the directory for which to download the plugins.
    const pluginsDir = pck.theiaPluginsDir || 'plugins';

    await mkdirpAsPromised(pluginsDir);

    const pluginResolvedXXX: PluginLockData = {};
    const pluginsLockFilePath = path.resolve(process.cwd(), 'theia-plugins.lock');

    if (await fs.stat(pluginsLockFilePath).then(() => true, () => false)) {
        console.log('Using existing theia-plugins.lock');

        const pluginsLockFileData = JSON.parse((
            await fs.readFile(pluginsLockFilePath, 'utf-8')));
        Object.keys(pluginsLockFileData).forEach((pluginSpec: string) => {
            pluginResolvedXXX[pluginSpec] = pluginsLockFileData[pluginSpec];
        });
        // console.log('pluginResolvedXXX', pluginResolvedXXX);
    }

    if (!pck.theiaPlugins) {
        console.log(red('error: missing mandatory \'theiaPlugins\' property.'));
        return;
    }
    try {
        await Promise.all(Object.keys(pck.theiaPlugins).map(
            plugin =>
                downloadPluginAsync(failures, plugin, pck.theiaPlugins[plugin], pluginsDir, packed, pluginResolvedXXX)
        ));
    } finally {
        temp.cleanupSync();
    }
    failures.forEach(e => { console.error(e); });
    if (!ignoreErrors && failures.length > 0) {
        throw new Error('Errors downloading some plugins. To make these errors non fatal, re-run with --ignore-errors');
    }
    console.log(`Saving plugin lockfile ${pluginsLockFilePath}`);
    await fs.writeFile(pluginsLockFilePath, JSON.stringify(pluginResolvedXXX, undefined, 4), 'utf-8');
    console.log(`ok, saved plugin lockfile ${pluginsLockFilePath}`);
}

/**
 * Downloads a plugin, will make multiple attempts before actually failing.
 *
 * @param failures reference to an array storing all failures
 * @param plugin plugin short name
 * @param pluginUrl url to download the plugin at
 * @param pluginsDir where to download the plugin in
 * @param packed whether to decompress or not
 */
async function downloadPluginAsync(failures: string[], plugin: string,
    pluginUrl: string, pluginsDir: string, packed: boolean, pluginMetadata: PluginLockData): Promise<void> {
    if (!plugin) {
        return;
    }
    let fileExt: string;
    if (pluginUrl.endsWith('tar.gz')) {
        fileExt = '.tar.gz';
    } else if (pluginUrl.endsWith('vsix')) {
        fileExt = '.vsix';
    } else {
        console.error(red(`error: '${plugin}' has an unsupported file type: '${pluginUrl}'`));
        return;
    }
    // XXX replace / -> - risk collisions
    const targetPath = path.join(process.cwd(), pluginsDir, `${plugin.replace('/', '-')}${packed === true ? fileExt : ''}`);
    // Skip plugins which have previously been downloaded.
    if (await isDownloaded(targetPath)) {
        console.warn('- ' + plugin + ': already downloaded - skipping');
        return;
    }

    const maxAttempts = 5;
    const retryDelay = 2000;

    let attempts: number;
    let lastError: Error | undefined;
    let response: Response | undefined;

    for (attempts = 0; attempts < maxAttempts; attempts++) {
        if (attempts > 0) {
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
        lastError = undefined;
        try {
            response = await xfetch(pluginUrl);
        } catch (error) {
            lastError = error;
            continue;
        }
        const retry = response.status === 439 || response.status >= 500;
        if (!retry) {
            break;
        }
    }
    if (lastError) {
        failures.push(red(`x ${plugin}: failed to download, last error: \n ${lastError} `));
        return;
    }
    if (typeof response === 'undefined') {
        failures.push(red(`x ${plugin}: failed to download(unknown reason)`));
        return;
    }
    if (response.status !== 200) {
        failures.push(red(`x ${plugin}: failed to download with: ${response.status} ${response.statusText} `));
        return;
    }

    const tempFile = temp.createWriteStream('theia-plugin-download');
    await pipelineAsPromised(response.body, tempFile);
    const sri = await fromStream(createReadStream(tempFile.path));

    const pluginSpec = `${plugin}@${pluginUrl}`;
    console.log('pluginSpec', pluginSpec);
    //  console.log('pluginMetadata', pluginMetadata);
    // console.log('pluginMetadata[pluginSpec]', pluginMetadata[pluginSpec]);

    let expectedSignature = pluginMetadata[pluginSpec]?.integrity;
    if (!expectedSignature) {
        console.warn(yellow(`No signature for ${pluginSpec} found in lockfile.`));
        expectedSignature = sri.toString();
        pluginMetadata[pluginSpec] = {
            resolved: pluginUrl,
            integrity: expectedSignature
        };
    }

    if (! await checkIntegrity(tempFile.path, expectedSignature)) {
        failures.push(red(`x ${plugin}: failed to verify checksum`));
        return;
    }
    if (fileExt === '.vsix' && packed === true) {
        // Download .vsix without decompressing.
        await fs.copyFile(tempFile.path, targetPath);
    } else {
        await mkdirpAsPromised(targetPath);
        await decompress(tempFile.path, targetPath);
    }

    console.warn(green(`+ ${plugin}: downloaded successfully ${attempts > 1 ? `(after ${attempts} attempts)` : ''} `));

}

/**
 * Determine if the resource for the given path is already downloaded.
 * @param filePath the resource path.
 *
 * @returns `true` if the resource is already downloaded, else `false`.
 */
async function isDownloaded(filePath: string): Promise<boolean> {
    return fs.stat(filePath).then(() => true, () => false);
}

/**
 * Check downloaded file match integrity.
 * @param filePath path of downloaded file
 * @param integrity checksum, in subresource integrity tag format
 */
async function checkIntegrity(filePath: string | Buffer, integrity?: string): Promise<boolean> {
    if (!integrity) {
        return Promise.resolve(true);
    }
    console.log(`checking integrity of ${filePath} against, ${integrity}`);
    return checkStream(createReadStream(filePath), integrity).then(() => true, () => false);
}

/**
 * Follow HTTP(S)_PROXY, ALL_PROXY and NO_PROXY environment variables.
 */
export function xfetch(url: string, options?: RequestInit): Promise<Response> {
    const proxiedOptions: RequestInit = { ...options };
    const proxy = getProxyForUrl(url);
    if (!proxiedOptions.agent && proxy !== '') {
        proxiedOptions.agent = new HttpsProxyAgent(proxy);
    }
    return fetch(url, proxiedOptions);
}
