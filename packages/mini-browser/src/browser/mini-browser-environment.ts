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

import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { Deferred } from '@theia/core/lib/common/promise-util';
import { inject, injectable, postConstruct } from 'inversify';
import { MiniBrowserEndpoint } from '../common/mini-browser-endpoint';

/**
 * Fetch values from the backend's environment.
 */
@injectable()
export class MiniBrowserEnvironment {

    protected readonly deferredHostPattern = new Deferred<string>();
    /**
     * The mini-browser host pattern as set in the backend's environment.
     */
    readonly hostPattern = this.deferredHostPattern.promise;

    @inject(EnvVariablesServer)
    protected readonly environment: EnvVariablesServer;

    @postConstruct()
    protected postConstruct(): void {
        this.environment.getValue(MiniBrowserEndpoint.HOST_PATTERN_ENV).then(envVar => {
            this.deferredHostPattern.resolve(envVar?.value || MiniBrowserEndpoint.HOST_PATTERN_DEFAULT);
        });
    }
}
