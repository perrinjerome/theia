/********************************************************************************
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

import * as assert from 'assert';
import * as fetchModule from 'node-fetch';
import { Response } from 'node-fetch';

import { expect } from 'chai';
import downloadPlugins from './download-plugins';
import * as sinon from 'sinon';
import * as temp from 'temp';
import * as rimraf from 'rimraf';
import * as path from 'path';
import { promises as fs, createReadStream } from 'fs';

describe('download plugins', () => {
    const processCwdStub = sinon.stub(process, 'cwd');
    const fetchModuleFetchStub = sinon.stub(fetchModule, 'default');
    const consoleErrorSpy = sinon.spy(console, 'error');

    let tempDir: string;
    let packageJsonPath: string;
    let pluginsLockPath: string;

    // will be mocked by test-resources/dummy-plugin.vsix
    const dummyPluginUrl = 'https://open-vsx.org/api/dummy/plugin/0.0.1/file/dummy.plugin-0.0.1.vsix';
    // integrity of test-resources/dummy-plugin.vsix
    const dummyPluginIntegrity = 'sha512-uvijULai88F1RAQzzioQb12+EzlU6clIJPXrddN211nvdJyXJsI5KGjQ3zTOvwIhES+6iLtRER4o7QG38pTmsQ==';

    beforeEach(async function (): Promise<void> {
        tempDir = temp.path(); // we don't use temp.mkdir, because download-plugins already temp.cleanup
        await fs.mkdir(tempDir);
        packageJsonPath = path.resolve(tempDir, 'package.json');
        pluginsLockPath = path.resolve(tempDir, 'theia-plugins.lock');

        // write a package.json in current directory
        processCwdStub.returns(tempDir);
        await fs.writeFile(packageJsonPath,
            JSON.stringify({
                'theiaPlugins': {
                    'dummy-plugin': dummyPluginUrl,
                }
            }));

        // mock fetch to return our dummy plugin
        fetchModuleFetchStub.value(async () =>
            Promise.resolve(
                new Response(
                    createReadStream(path.resolve(__dirname, '../test-resources/dummy-plugin.vsix')),
                    {
                        status: 200,
                        headers: { 'Content-type': 'application/octet-stream' }
                    }
                )
            )
        );
    });

    afterEach(() => {
        rimraf.sync(tempDir);
    });

    after(() => {
        processCwdStub.restore();
        consoleErrorSpy.restore();
        fetchModuleFetchStub.restore();
    });

    it('download and unpacks plugins', async function (): Promise<void> {
        await downloadPlugins();
        // plugins dir contain one plugin
        const pluginsDirContent = await fs.readdir(path.resolve(tempDir, 'plugins'));
        expect(pluginsDirContent).to.deep.equal(['dummy-plugin']);
        // this plugin directory is not empty
        const pluginDirContent = await fs.readdir(path.resolve(tempDir, 'plugins/dummy-plugin'));
        expect(pluginDirContent).to.deep.include('extension.vsixmanifest');
    });

    it('download and keep packed plugins', async function (): Promise<void> {
        await downloadPlugins({ packed: true });
        // plugins dir contain one plugin
        const pluginsDirContent = await fs.readdir(path.resolve(tempDir, 'plugins'));
        expect(pluginsDirContent).to.deep.equal(['dummy-plugin.vsix']);
    });

    it('fails on download error', async function (): Promise<void> {
        fetchModuleFetchStub.value(async () => new Response('404', { status: 404, }));
        await assert.rejects(downloadPlugins);
        sinon.assert.calledWithMatch(consoleErrorSpy, 'dummy-plugin: failed to download with: 404 Not Found');
    });

    it('writes signatures in lockfile', async function (): Promise<void> {
        await downloadPlugins();
        const lock = JSON.parse(await fs.readFile(pluginsLockPath, 'utf-8'));
        expect(lock[`dummy-plugin@${dummyPluginUrl}`]).to.include({
            'integrity': dummyPluginIntegrity
        });
    });

    it('verifies signatures from lockfile on download', async function (): Promise<void> {
        await fs.writeFile(pluginsLockPath,
            JSON.stringify({
                [`dummy-plugin@${dummyPluginUrl}`]: {
                    'resolved': dummyPluginUrl,
                    'integrity': 'sha512-wrongsignature'
                }
            }));

        await assert.rejects(downloadPlugins);
        sinon.assert.calledWithMatch(consoleErrorSpy, 'dummy-plugin: failed to verify checksum');

        // plugin was not downloaded
        const pluginsDirContent = await fs.readdir(path.resolve(tempDir, 'plugins'));
        expect(pluginsDirContent).to.deep.equal([]);
    });
});
