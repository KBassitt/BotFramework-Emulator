//
// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license.
//
// Microsoft Bot Framework: http://botframework.com
//
// Bot Framework Emulator Github:
// https://github.com/Microsoft/BotFramwork-Emulator
//
// Copyright (c) Microsoft Corporation
// All rights reserved.
//
// MIT License:
// Permission is hereby granted, free of charge, to any person obtaining
// a copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to
// the following conditions:
//
// The above copyright notice and this permission notice shall be
// included in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED ""AS IS"", WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
// LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
// OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
// WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//

import { BrowserWindow } from 'electron';
import * as fetch from 'electron-fetch';
import * as uuidv3 from 'uuid/v3';
import * as uuidv4 from 'uuid/v4';
import * as jwt from 'jsonwebtoken';

let getPem = require('rsa-pem-from-mod-exp');

declare type AzureAuthWorkflowType = IterableIterator<Promise<BrowserWindow> | Promise<{ armToken: string } | boolean>>;
declare type AzureSignoutWorkflowType = IterableIterator<Promise<BrowserWindow | boolean>>;
declare type Config = { authorization_endpoint: string, jwks_uri: string };

export class AzureAuthWorkflowService {

  private static config: Config;

  public static* enterAuthWorkflow(renew: boolean = false, redirectUri: string): AzureAuthWorkflowType {
    const authWindow = yield this.launchAuthWindow(renew, redirectUri);
    authWindow.show();
    const result = yield this.waitForDataFromAuthWindow(authWindow);
    authWindow.close();
    yield result;
  }

  public static* enterSignOutWorkflow(prompt: boolean): AzureSignoutWorkflowType {
    const signOutWindow = yield this.launchSignOutWindow(prompt);
    signOutWindow.show();

    const result = yield this.waitForDataFromSignOutWindow(signOutWindow);
    signOutWindow.close();
    yield result;
  }

  private static async waitForDataFromAuthWindow(bWindow: BrowserWindow): Promise<{ armToken: string } | boolean> {
    const armToken: string | boolean = await new Promise<string | boolean>(resolve => {
      bWindow.addListener('close', () => resolve(false));
      bWindow.addListener('page-title-updated', event => {
        const uri: string = (event.sender as any).history.pop() || '';
        if (!uri.toLowerCase().includes('localhost')) {
          return;
        }
        const idx = uri.indexOf('#');
        const values = uri.substring(idx).split('&');
        const len = values.length;
        for (let i = 0; i < len; i++) {
          const [key, value] = values[i].split(/[=]/);
          if (key.includes('id_token')) {
            resolve(value);
            break;
          }
          if (key.includes('error')) {
            resolve(false);
            break;
          }
        }
      });
    });
    if (!armToken) {
      return false;
    }
    const isValid = await this.validateJWT(armToken as string);
    return isValid ? { armToken: armToken as string } : false;
  }

  private static async launchAuthWindow(renew: boolean, redirectUri: string): Promise<BrowserWindow> {
    const browserWindow = new BrowserWindow({
      modal: true,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      width: 490,
      height: 366,
      webPreferences: { contextIsolation: true, nativeWindowOpen: true }
    });
    const { authorization_endpoint: endpoint } = await this.getConfig();
    const clientId = '4f28e5eb-6b7f-49e6-ac0e-f992b622da57';
    const state = uuidv4();
    const requestId = uuidv4();
    const nonce = uuidv3('https://github.com/Microsoft/BotFramework-Emulator', uuidv3.URL);
    const bits = [
      `${endpoint}?response_type=id_token`,
      `client_id=${clientId}`,
      `redirect_uri=${redirectUri}`,
      `state=${state}`,
      `client-request-id=${requestId}`,
      `nonce=${nonce}`,
      'x-client-SKU=Js',
      'x-client-Ver=1.0.17',
    ];
    if (renew) {
      bits.push('prompt=none');
    }
    const url = bits.join('&');
    browserWindow.loadURL(url);
    return new Promise<BrowserWindow>(resolve => {
      browserWindow.once('ready-to-show', () => resolve(browserWindow));
    });
  }

  private static async launchSignOutWindow(prompt: boolean): Promise<BrowserWindow> {
    const browserWindow = new BrowserWindow({
      modal: true,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      width: 440,
      height: 367,
      webPreferences: { contextIsolation: true, nativeWindowOpen: true }
    });
    const redirectUri = 'http://localhost:3000/botframework-emulator';
    const bits = [
      `https://login.microsoftonline.com/common/oauth2/logout/?post_logout_redirect_uri=${redirectUri}`,
      'x-client-SKU=Js',
      'x-client-Ver=1.0.17'
    ];
    if (!prompt) {
      bits.push('prompt=none');
    }
    const url = bits.join('&');
    browserWindow.loadURL(url);
    return new Promise<BrowserWindow>(resolve => {
      browserWindow.once('ready-to-show', () => resolve(browserWindow));
    });
  }

  private static waitForDataFromSignOutWindow(browserWindow: BrowserWindow): Promise<boolean> {
    return new Promise(resolve => {
      // Since redirects to localhost are not reliable,
      // if signing out does not succeed after
      // 5 seconds, treat it as a successful logout
      // so the emulator will not attempt to auth
      // on the next startup
      let timeout = setTimeout(resolve.bind(null, true), 5000);
      browserWindow.addListener('page-title-updated', event => {
        const uri: string = (event.sender as any).history.pop() || '';
        if (!uri.toLowerCase().includes('localhost')) {
          return;
        }
        clearTimeout(timeout);
        resolve(true);
      });
    });
  }

  private static async getConfig(): Promise<Config> {
    if (this.config) {
      return this.config;
    }
    const configUrl = 'https://login.microsoftonline.com/common/.well-known/openid-configuration';
    const configResponse = await (fetch as any).default(configUrl);
    this.config = await configResponse.json();
    return this.config;
  }

  private static async validateJWT(token: string): Promise<boolean> {
    const [header] = token.split('.');
    const headers: { alg: string, kid: string, x5t: string } = JSON.parse(Buffer.from(header, 'base64').toString());

    try {
      const { jwks_uri } = await this.getConfig();
      const jwksResponse = await (fetch as any).default(jwks_uri);
      const responseJson: { keys: { x5t: string, n: string, e: string, x5c: string[] }[] } = await jwksResponse.json();
      const jwk = responseJson.keys.find(key => key.x5t === headers.x5t);
      jwt.verify(token, getPem(jwk.n, jwk.e));
      return true;
    } catch (e) {
      return false;
    }
  }
}
