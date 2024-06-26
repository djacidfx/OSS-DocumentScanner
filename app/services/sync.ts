import { ApplicationSettings, File, Folder, ImageSource, Observable, path } from '@nativescript/core';
import { debounce, throttle } from '@nativescript/core/utils';
import { cropDocument, cropDocumentFromFile } from 'plugin-nativeprocessor';
import { Document, OCRDocument, OCRPage } from '~/models/OCRDocument';
import { IMG_COMPRESS, IMG_FORMAT, SETTINGS_WEBDAV_AUTO_SYNC, WEBDAV_AUTO_SYNC } from '~/utils/constants';
import { showError } from '~/utils/error';
import { loadImage, recycleImages } from '~/utils/images';
import { AuthType, FileStat, WebDAVClient, createClient, createContext } from '~/webdav';
import { exists } from '~/webdav/operations/exists';
import { basename } from '~/webdav/tools/path';
import { networkService } from './api';
import { DocumentsService, documentsService } from './documents';
import { lc } from '@nativescript-community/l';
import { prefs } from './preferences';
import { getImagePipeline } from '@nativescript-community/ui-image';

const SETTINGS_KEY = 'webdav_config';
function findArrayDiffs<S, T>(array1: S[], array2: T[], compare: (a: S, b: T) => boolean) {
    const union: S[] = [];
    array1 = Array.from(array1);
    array2 = Array.from(array2);
    for (let i = 0; i < array1.length; i++) {
        const a = array1[i];
        for (let j = 0; j < array2.length; j++) {
            const b = array2[j];
            if (compare(a, b)) {
                union.push(a);
                array1.splice(i, 1);
                array2.splice(j, 1);
                i--;
                break;
            }
        }
    }
    return {
        toBeAdded: array2,
        toBeDeleted: array1,
        union
    };
}

export class SyncService extends Observable {
    remoteURL;
    username;
    remoteFolder;
    authType;
    client: WebDAVClient;
    token;
    password;
    autoSync = true;

    get enabled() {
        return !!this.client;
    }
    onDocumentAdded() {
        DEV_LOG && console.log('SYNC', 'onDocumentAdded');
        this.syncDocuments();
    }
    onDocumentDeleted(event) {
        DEV_LOG && console.log('SYNC', 'onDocumentDeleted');
        const documentsToDeleteOnRemote = JSON.parse(ApplicationSettings.getString('sync_docs_to_remove_remote', '[]'));
        documentsToDeleteOnRemote.push(...event.documents.map((d) => d.id));
        ApplicationSettings.setString('sync_docs_to_remove_remote', JSON.stringify(documentsToDeleteOnRemote));
        this.syncDocuments();
    }
    onDocumentUpdated(event) {
        // TODO: fast and dirty
        DEV_LOG && console.log('SYNC', 'onDocumentUpdated', event.updateModifiedDate);
        if (event.updateModifiedDate !== false) {
            this.syncDocuments();
        }
    }
    onAutoSyncPrefChanged() {
        this.autoSync = ApplicationSettings.getBoolean(SETTINGS_WEBDAV_AUTO_SYNC, WEBDAV_AUTO_SYNC);
        DEV_LOG && console.log('onAutoSyncPrefChanged', this.autoSync);
    }
    async start() {
        prefs.on(`key:${SETTINGS_WEBDAV_AUTO_SYNC}`, this.onAutoSyncPrefChanged);
        this.onAutoSyncPrefChanged();
        const configStr = ApplicationSettings.getString(SETTINGS_KEY);
        if (configStr) {
            const config = JSON.parse(configStr);
            const { remoteURL, headers, authType, ...otherConfig } = config;
            // const context = createContext(config.remoteURL, { config.username, password, authType: AuthType.Password });
            this.remoteURL = remoteURL;
            this.authType = authType;
            this.remoteFolder = config.remoteFolder;
            this.username = config.username;
            this.token = config.token;
            this.client = createClient(remoteURL, {
                headers,
                authType: !authType || authType === AuthType.Password ? AuthType.None : authType,
                ...otherConfig
            });
            DEV_LOG && console.log('SyncService', 'start', config);
            this.notify({ eventName: 'state', enabled: this.enabled });
            documentsService.on('documentAdded', this.onDocumentAdded, this);
            documentsService.on('documentUpdated', this.onDocumentUpdated, this);
            documentsService.on('documentsDeleted', this.onDocumentDeleted, this);
        }
    }
    stop() {
        prefs.off(`key:${SETTINGS_WEBDAV_AUTO_SYNC}`, this.onAutoSyncPrefChanged);
        documentsService.off('documentAdded', this.onDocumentAdded, this);
        documentsService.off('documentUpdated', this.onDocumentUpdated, this);
        documentsService.off('documentsDeleted', this.onDocumentDeleted, this);
    }

    async saveData({ remoteURL, username, password, remoteFolder, authType = AuthType.Password, token }) {
        if (remoteURL && username && password && remoteFolder) {
            // TODO: if we use digest we need a test connection to acquire the ha1

            const context = createContext(remoteURL, { username, password, authType, token });
            const config = {
                remoteURL,
                username,
                headers: context.headers,
                remoteFolder,
                ha1: context.ha1 || context.digest?.ha1,
                authType,
                // password: authType === AuthType.Password ? password : undefined,
                token
            };
            DEV_LOG && console.log('saveData', context, config);
            ApplicationSettings.setString(SETTINGS_KEY, JSON.stringify(config));
            await this.start();
            this.syncDocuments();
        } else {
            ApplicationSettings.remove(SETTINGS_KEY);
            this.client = null;
            this.remoteURL = null;
            this.username = null;
            this.remoteFolder = null;
            this.authType = null;
            this.token = null;
        }
        this.notify({ eventName: 'state', enabled: this.enabled });
    }
    async testConnection({ remoteURL, username, password, remoteFolder, token, authType = null }): Promise<boolean> {
        try {
            const context = createContext(remoteURL, { password, username, authType: authType || AuthType.Password, token: token ? { access_token: token, token_type: 'Bearer' } : token });
            DEV_LOG && console.log('testConnection', context);
            await exists(context, remoteFolder, { cachePolicy: 'noCache' });
            return true;
        } catch (error) {
            console.error(error, error.stack);
            return false;
        }
    }

    async ensureRemoteFolder() {
        DEV_LOG && console.log('ensureRemoteFolder', this.remoteFolder);
        if (!(await this.client.exists(this.remoteFolder))) {
            await this.client.createDirectory(this.remoteFolder, { recursive: true });
        }
    }

    async getRemoteFolderDirectories(folderStr: string) {
        return this.client.getDirectoryContents(folderStr, { includeSelf: false, details: false });
    }
    async sendFolderToWebDav(folder: Folder, remotePath: string) {
        DEV_LOG && console.log('sendFolderToWebDav', folder, remotePath);
        try {
            await this.client.createDirectory(remotePath, { recursive: false });
        } catch (error) {
            if (error.statusCode !== 405) {
                throw error;
            }
        }
        const entities = await folder.getEntities();
        for (let index = 0; index < entities.length; index++) {
            const entity = entities[index];
            if (entity instanceof File) {
                await this.client.putFileContents(path.join(remotePath, entity.name), File.fromPath(entity.path));
            } else {
                await this.sendFolderToWebDav(Folder.fromPath(entity.path), path.join(remotePath, entity.name));
            }
        }
    }
    async removeDocumentFromWebdav(remotePath: string) {
        DEV_LOG && console.log('removeDocumentFromWebdav', remotePath);
        return this.client.deleteFile(remotePath);
        // const remoteDocuments = (await this.getRemoteFolderDirectories(remotePath)) as FileStat[];
        // for (let index = 0; index < remoteDocuments.length; index++) {
        //     const remoteDocument = remoteDocuments[index];
        //     if (ignores?.indexOf(remoteDocument.basename) >= 0) {
        //         continue;
        //     }
        //     if (remoteDocument.type === 'directory') {
        //         await this.importFolderFromWebdav(path.join(remotePath, remoteDocument.basename), folder.getFolder(remoteDocument.basename));
        //     } else {
        //         await this.client.getFileContents(path.join(remotePath, remoteDocument.basename), {
        //             format: 'file',
        //             destinationFilePath: path.join(folder.path, remoteDocument.basename)
        //         });
        //     }
        // }
    }
    async importFolderFromWebdav(remotePath: string, folder: Folder, ignores?: string[]) {
        if (!folder?.path) {
            throw new Error('importFolderFromWebdav missing folder');
        }
        const remoteDocuments = (await this.getRemoteFolderDirectories(remotePath)) as FileStat[];
        DEV_LOG && console.log('importFolderFromWebdav', remotePath, folder.path, ignores);
        for (let index = 0; index < remoteDocuments.length; index++) {
            const remoteDocument = remoteDocuments[index];
            if (ignores?.indexOf(remoteDocument.basename) >= 0) {
                continue;
            }
            if (remoteDocument.type === 'directory') {
                await this.importFolderFromWebdav(path.join(remotePath, remoteDocument.basename), folder.getFolder(remoteDocument.basename));
            } else {
                await this.client.getFileContents(path.join(remotePath, remoteDocument.basename), {
                    format: 'file',
                    destinationFilePath: path.join(folder.path, remoteDocument.basename)
                });
            }
        }
    }
    async addDocumentToWebdav(document: OCRDocument) {
        TEST_LOG && console.log('addDocumentToWebdav', document.id, document.pages);
        const docFolder = documentsService.dataFolder.getFolder(document.id);
        await this.sendFolderToWebDav(docFolder, path.join(this.remoteFolder, document.id));
        await this.client.putFileContents(path.join(this.remoteFolder, document.id, 'data.json'), document.toString());
        // mark the document as synced
        // TEST_LOG && console.log('addDocumentToWebdav done saving synced state', document.id, document.pages);
        return document.save({ _synced: 1 }, false);
    }
    async importDocumentFromWebdav(data: FileStat) {
        const dataJSON = JSON.parse(
            await this.client.getFileContents(path.join(data.filename, 'data.json'), {
                format: 'text'
            })
        ) as Document & { pages: OCRPage[]; db_version?: number };
        const { pages, db_version, ...docProps } = dataJSON;
        if (db_version > DocumentsService.DB_VERSION) {
            throw new Error(lc('document_need_updated_app', docProps.name));
        }
        let docId;
        let pageIds = [];
        let docDataFolder: Folder;
        try {
            const doc = await documentsService.documentRepository.createDocument({ ...docProps, _synced: 1 });
            docId = doc.id;
            docDataFolder = documentsService.dataFolder.getFolder(docId);
            TEST_LOG && console.log('importDocumentFromWebdav', docDataFolder.path, data, JSON.stringify(dataJSON));
            pages.forEach((page) => {
                const pageDataFolder = docDataFolder.getFolder(page.id);
                page.sourceImagePath = path.join(pageDataFolder.path, basename(page.sourceImagePath));
                page.imagePath = path.join(pageDataFolder.path, basename(page.imagePath));
            });
            pageIds = pages.map((p) => p.id);
            await this.importFolderFromWebdav(data.filename, docDataFolder, ['data.json']);
            await doc.addPages(pages);
            await doc.save({ _synced: 1 }, true, false);
            TEST_LOG && console.log('importFolderFromWebdav done');
            documentsService.notify({ eventName: 'documentAdded', object: documentsService, doc });
        } catch (error) {
            console.error('error while adding remote doc, let s remove it', docId, pageIds);
            // there was an error while creating the doc. remove it so that we can try again later
            if (docId) {
                await documentsService.documentRepository.delete({ id: docId } as any);
                await Promise.all(pageIds.map((p) => documentsService.pageRepository.delete({ id: p.id } as any)));
            }
            if (Folder.exists(docDataFolder.path)) {
                await docDataFolder.remove();
            }
            throw error;
        }

        //_synced:1!
        // mark the document as synced
    }
    async syncDocumentOnWebdav(document: OCRDocument) {
        TEST_LOG && console.log('syncDocumentOnWebdav', document.id);
        const remoteDocPath = path.join(this.remoteFolder, document.id);
        const dataJSON = JSON.parse(
            await this.client.getFileContents(path.join(remoteDocPath, 'data.json'), {
                format: 'text'
            })
        ) as OCRDocument;
        const docDataFolder = documentsService.dataFolder.getFolder(document.id);
        DEV_LOG && console.log('syncDocumentOnWebdav', document.id, document.modifiedDate, dataJSON.modifiedDate);
        if (dataJSON.modifiedDate > document.modifiedDate) {
            let needsRemoteDocUpdate = false;
            const { pages: docPages, ...docProps } = document.toJSONObject();
            const { pages: remotePages, ...remoteProps } = dataJSON;
            const toUpdate = {};
            Object.keys(remoteProps).forEach((k) => {
                if (k.startsWith('_')) {
                    return;
                }
                if (remoteProps[k] !== docProps[k]) {
                    toUpdate[k] = remoteProps[k];
                }
            });
            const { toBeAdded: missingLocalPages, toBeDeleted: removedRemotePages, union: toBeSyncPages } = findArrayDiffs(docPages as OCRPage[], remotePages, (a, b) => a.id === b.id);

            TEST_LOG &&
                console.log(
                    'document need to be synced FROM webdav!',
                    toUpdate,
                    missingLocalPages,
                    removedRemotePages,
                    toBeSyncPages.map((p) => p.id)
                );
            TEST_LOG &&
                console.log(
                    'missingLocalPages',
                    missingLocalPages.map((p) => p.id)
                );
            TEST_LOG &&
                console.log(
                    'removedRemotePages',
                    removedRemotePages.map((p) => p.id)
                );
            TEST_LOG &&
                console.log(
                    'toBeSyncPages',
                    toBeSyncPages.map((p) => p.id)
                );
            for (let index = 0; index < removedRemotePages.length; index++) {
                const pageToRemove = removedRemotePages[index];
                const pageIndex = (docPages as OCRPage[]).findIndex((p) => p.id === pageToRemove.id);
                if (pageIndex !== -1) {
                    document.deletePage(pageIndex);
                }
            }
            for (let index = 0; index < missingLocalPages.length; index++) {
                const missingLocalPage = missingLocalPages[index];
                const pageDataFolder = docDataFolder.getFolder(missingLocalPage.id);
                missingLocalPage.sourceImagePath = path.join(pageDataFolder.path, basename(missingLocalPage.sourceImagePath));
                missingLocalPage.imagePath = path.join(pageDataFolder.path, basename(missingLocalPage.imagePath));
                await this.importFolderFromWebdav(path.join(remoteDocPath, missingLocalPage.id), pageDataFolder);

                // we insert page one by one because of the index
                await document.addPage(
                    missingLocalPage,
                    remotePages.findIndex((p) => p.id === missingLocalPage.id)
                );
                // await document.save();
            }
            for (let index = 0; index < toBeSyncPages.length; index++) {
                const localPage = toBeSyncPages[index];
                const localPageIndex = (docPages as OCRPage[]).findIndex((p) => p.id === localPage.id);
                const remotePageIndex = remotePages.findIndex((p) => p.id === localPage.id);
                const remotePageToSync = remotePages[remotePageIndex];
                TEST_LOG && console.log('sync page', remotePageToSync.id, remotePageToSync.modifiedDate, localPage.modifiedDate);
                if (remotePageToSync.modifiedDate > localPage.modifiedDate) {
                    //we need to update the data and then recreate the image if necessary
                    const { imagePath: localImagePath, sourceImagePath: localSourceImagePath, ...pageProps } = localPage;
                    const { imagePath: remoteImagePath, sourceImagePath: remoteSourceImagePath, ...remotePageProps } = remotePageToSync;
                    const pageToUpdate: Partial<OCRPage> = {};
                    Object.keys(remotePageProps).forEach((k) => {
                        if (k.startsWith('_')) {
                            return;
                        }
                        if (remotePageProps[k] !== pageProps[k] && JSON.stringify(remotePageProps[k]) !== JSON.stringify(pageProps[k])) {
                            pageToUpdate[k] = remotePageProps[k];
                        }
                    });
                    // check if we need to recreate the image
                    let imageChanged = false;
                    TEST_LOG && console.log('sync page FROM webdav!', remotePageToSync.id, JSON.stringify(pageToUpdate));
                    if (pageToUpdate.crop || pageToUpdate.transforms) {
                        const file = File.fromPath(localPage.imagePath);
                        const crop = pageToUpdate.crop || localPage.crop;
                        const transforms = pageToUpdate.transforms || localPage.transforms;
                        imageChanged = true;
                        DEV_LOG && console.log('page sync needed size update', file.size, transforms, crop);

                        await cropDocumentFromFile(localPage.sourceImagePath, [crop], {
                            saveInFolder: file.parent.path,
                            fileName: file.name,
                            compressFormat: IMG_FORMAT,
                            compressQuality: IMG_COMPRESS,
                            transforms
                        });
                        pageToUpdate.size = file.size;
                    } else if (pageToUpdate.size === 0) {
                        const file = File.fromPath(localPage.imagePath);
                        pageToUpdate.size = file.size;
                    }
                    await document.updatePage(localPageIndex, pageToUpdate, imageChanged);
                } else if (remotePageToSync.modifiedDate < localPage.modifiedDate) {
                    //we need to update the data and then recreate the image if necessary
                    const { imagePath: localImagePath, sourceImagePath: localSourceImagePath, ...pageProps } = localPage;
                    const { imagePath: remoteImagePath, sourceImagePath: remoteSourceImagePath, ...remotePageProps } = remotePageToSync;
                    const pageTooUpdate: Partial<OCRPage> = {};
                    Object.keys(pageProps).forEach((k) => {
                        if (k.startsWith('_')) {
                            return;
                        }
                        if (remotePageProps[k] !== pageProps[k]) {
                            pageTooUpdate[k] = pageProps[k];
                        }
                    });
                    // check if we need to upload the image
                    TEST_LOG && console.log('sync page FROM local!', remotePageToSync.id, JSON.stringify(pageTooUpdate));
                    if (pageTooUpdate.crop || pageTooUpdate.transforms) {
                        await this.client.putFileContents(path.join(remoteDocPath, basename(localImagePath)), localImagePath);
                    }
                    needsRemoteDocUpdate = true;
                }
            }
            TEST_LOG && console.log('update document', toUpdate);
            // mark the document as synced
            await document.save({ _synced: 1, ...toUpdate });

            if (needsRemoteDocUpdate) {
                await this.client.putFileContents(path.join(remoteDocPath, 'data.json'), document.toString());
            }
        } else if (dataJSON.modifiedDate < document.modifiedDate) {
            // DEV_LOG && console.log('syncDocumentOnWebdav', document.id, document.modifiedDate, dataJSON.modifiedDate);
            const { pages: docPages, ...docProps } = document.toJSONObject();
            const { pages: remotePages, ...remoteProps } = dataJSON;
            // const toUpdate = {};
            // Object.keys(remoteProps).forEach((k) => {
            //     if (k.startsWith('_')) {
            //         return;
            //     }
            //     if (remoteProps[k] !== docProps[k]) {
            //         toUpdate[k] = remoteProps[k];
            //     }
            // });
            const { toBeAdded: missingRemotePages, toBeDeleted: removedRemotePages, union: toBeSyncPages } = findArrayDiffs(remotePages, docPages as OCRPage[], (a, b) => a.id === b.id);
            TEST_LOG && console.log('document need to be synced FROM local!', remoteDocPath, document.pages.length);
            TEST_LOG &&
                console.log(
                    'missingRemotePages',
                    missingRemotePages.map((p) => p.id)
                );
            TEST_LOG &&
                console.log(
                    'removedRemotePages',
                    removedRemotePages.map((p) => p.id)
                );
            TEST_LOG &&
                console.log(
                    'toBeSyncPages',
                    toBeSyncPages.map((p) => p.id)
                );
            for (let index = 0; index < missingRemotePages.length; index++) {
                const missingRemotePage = missingRemotePages[index];
                const pageDataFolder = docDataFolder.getFolder(missingRemotePage.id);
                await this.sendFolderToWebDav(pageDataFolder, path.join(remoteDocPath, missingRemotePage.id));
            }
            for (let index = 0; index < removedRemotePages.length; index++) {
                const removedRemotePage = removedRemotePages[index];
                await this.client.deleteFile(path.join(remoteDocPath, removedRemotePage.id));
            }

            for (let index = 0; index < toBeSyncPages.length; index++) {
                const remotePage = toBeSyncPages[index];
                const remotePageIndex = remotePages.findIndex((p) => p.id === remotePage.id);
                const localPageIndex = (docPages as OCRPage[]).findIndex((p) => p.id === remotePage.id);
                const localPageToSync = docPages[localPageIndex];
                TEST_LOG && console.log('sync page', localPageToSync.id, localPageToSync.modifiedDate, remotePage.modifiedDate);
                if (remotePage.modifiedDate > localPageToSync.modifiedDate) {
                    //we need to update the data and then recreate the image if necessary
                    const { imagePath: localImagePath, sourceImagePath: localSourceImagePath, ...pageProps } = localPageToSync;
                    const { imagePath: remoteImagePath, sourceImagePath: remoteSourceImagePath, ...remotePageProps } = remotePage;
                    const pageToUpdate: Partial<OCRPage> = {};
                    Object.keys(remotePageProps).forEach((k) => {
                        if (k.startsWith('_')) {
                            return;
                        }
                        if (remotePageProps[k] !== pageProps[k] && JSON.stringify(remotePageProps[k]) !== JSON.stringify(pageProps[k])) {
                            pageToUpdate[k] = remotePageProps[k];
                        }
                    });
                    // check if we need to recreate the image
                    TEST_LOG && console.log('sync page FROM webdav!', localPageToSync.id, JSON.stringify(pageToUpdate));
                    let imageChanged = false;
                    if (pageToUpdate.crop || pageToUpdate.transforms) {
                        const file = File.fromPath(localPageToSync.imagePath);

                        const crop = pageToUpdate.crop || localPageToSync.crop;
                        const transforms = pageToUpdate.transforms || localPageToSync.transforms;
                        DEV_LOG && console.log('page sync needed size update', file.size, transforms, crop);
                        await cropDocumentFromFile(localPageToSync.sourceImagePath, [crop], {
                            saveInFolder: file.parent.path,
                            fileName: file.name,
                            compressFormat: IMG_FORMAT,
                            compressQuality: IMG_COMPRESS,
                            transforms
                        });
                        pageToUpdate.size = file.size;
                        imageChanged = true;
                    } else if (pageToUpdate.size === 0) {
                        const file = File.fromPath(localPageToSync.imagePath);
                        pageToUpdate.size = file.size;
                    }
                    await document.updatePage(localPageIndex, pageToUpdate, imageChanged);
                } else if (remotePage.modifiedDate < localPageToSync.modifiedDate) {
                    //we need to update the data and then recreate the image if necessary
                    const { imagePath: localImagePath, sourceImagePath: localSourceImagePath, ...pageProps } = localPageToSync;
                    const { imagePath: remoteImagePath, sourceImagePath: remoteSourceImagePath, ...remotePageProps } = remotePage;
                    const pageTooUpdate: Partial<OCRPage> = {};
                    Object.keys(pageProps).forEach((k) => {
                        if (k.startsWith('_')) {
                            return;
                        }
                        if (remotePageProps[k] !== pageProps[k]) {
                            pageTooUpdate[k] = pageProps[k];
                        }
                    });
                    // check if we need to upload the image
                    TEST_LOG && console.log('sync page FROM local!', localPageToSync.id, JSON.stringify(pageTooUpdate));
                    if (pageTooUpdate.crop || pageTooUpdate.transforms) {
                        await this.client.putFileContents(path.join(remoteDocPath, basename(localImagePath)), localImagePath);
                    }
                }
            }
            await this.client.putFileContents(path.join(remoteDocPath, 'data.json'), document.toString(), { overwrite: true });
            return document.save({ _synced: 1 });
        } else if (document._synced === 0) {
            TEST_LOG && console.log('syncDocumentOnWebdav just changing sync state');
            return document.save({ _synced: 1 });
        }
    }
    syncRunning = false;
    syncDocuments = throttle(async (force = false, bothWays = false) => {
        try {
            if ((!force && !this.autoSync) || !networkService.connected || !this.client || this.syncRunning) {
                return;
            }
            this.syncRunning = true;
            this.notify({ eventName: 'syncState', state: 'running' });
            TEST_LOG && console.log('syncDocuments', bothWays);
            const localDocuments = await documentsService.documentRepository.search({});
            const documentsToDeleteOnRemote = JSON.parse(ApplicationSettings.getString('sync_docs_to_remove_remote', '[]'));

            TEST_LOG &&
                console.log(
                    'localDocuments',
                    localDocuments.map((d) => d.id)
                );

            TEST_LOG && console.log('documentsToDeleteOnRemote', documentsToDeleteOnRemote);
            if (bothWays) {
                await this.ensureRemoteFolder();
                const remoteDocuments = (await this.getRemoteFolderDirectories(this.remoteFolder)) as FileStat[];
                TEST_LOG && console.log('remoteDocuments', JSON.stringify(remoteDocuments));
                const {
                    toBeAdded: missingLocalDocuments,
                    toBeDeleted: missingRemoteDocuments,
                    union: toBeSyncDocuments
                } = findArrayDiffs(localDocuments, remoteDocuments, (a, b) => a.id === b.basename);

                TEST_LOG &&
                    console.log(
                        'missingRemoteDocuments',
                        missingRemoteDocuments.map((d) => d.id)
                    );
                TEST_LOG &&
                    console.log(
                        'missingLocalDocuments',
                        missingLocalDocuments.map((d) => d.basename)
                    );
                TEST_LOG &&
                    console.log(
                        'toBeSyncDocuments',
                        toBeSyncDocuments.map((d) => d.id)
                    );

                for (let index = 0; index < documentsToDeleteOnRemote.length; index++) {
                    const id = documentsToDeleteOnRemote[index];
                    const missingLocalIndex = missingLocalDocuments.findIndex((d) => d.basename === id);
                    if (missingLocalIndex !== -1) {
                        missingLocalDocuments.splice(missingLocalIndex, 1);
                        await this.removeDocumentFromWebdav(path.join(this.remoteFolder, id));
                    }
                }
                ApplicationSettings.remove('sync_docs_to_remove_remote');
                for (let index = 0; index < missingRemoteDocuments.length; index++) {
                    await this.addDocumentToWebdav(missingRemoteDocuments[index]);
                }
                for (let index = 0; index < missingLocalDocuments.length; index++) {
                    await this.importDocumentFromWebdav(missingLocalDocuments[index]);
                }
                for (let index = 0; index < toBeSyncDocuments.length; index++) {
                    await this.syncDocumentOnWebdav(toBeSyncDocuments[index]);
                }
            } else {
                const documentsToSync = localDocuments.filter((d) => !d._synced).concat(documentsToDeleteOnRemote);
                if (documentsToSync.length) {
                    await this.ensureRemoteFolder();
                    const remoteDocuments = (await this.getRemoteFolderDirectories(this.remoteFolder)) as FileStat[];
                    TEST_LOG && console.log('remoteDocuments', JSON.stringify(remoteDocuments));
                    const {
                        toBeAdded: missingLocalDocuments,
                        toBeDeleted: missingRemoteDocuments,
                        union: toBeSyncDocuments
                    } = findArrayDiffs(localDocuments, remoteDocuments, (a, b) => a.id === b.basename);
                    TEST_LOG &&
                        console.log(
                            'missingRemoteDocuments',
                            missingRemoteDocuments.map((d) => d.id)
                        );
                    TEST_LOG &&
                        console.log(
                            'missingLocalDocuments',
                            missingLocalDocuments.map((d) => d.basename)
                        );
                    TEST_LOG &&
                        console.log(
                            'toBeSyncDocuments',
                            toBeSyncDocuments.map((d) => d.id)
                        );
                    for (let index = 0; index < documentsToDeleteOnRemote.length; index++) {
                        const id = documentsToDeleteOnRemote[index];
                        const missingLocalIndex = missingLocalDocuments.findIndex((d) => d.basename === id);
                        if (missingLocalIndex !== -1) {
                            missingLocalDocuments.splice(missingLocalIndex, 1);
                            await this.removeDocumentFromWebdav(path.join(this.remoteFolder, id));
                        }
                    }
                    for (let index = 0; index < missingRemoteDocuments.length; index++) {
                        await this.addDocumentToWebdav(missingRemoteDocuments[index]);
                    }
                    // for (let index = 0; index < missingLocalDocuments.length; index++) {
                    //     await this.importDocumentFromWebdav(missingLocalDocuments[index]);
                    // }
                    for (let index = 0; index < toBeSyncDocuments.length; index++) {
                        await this.syncDocumentOnWebdav(toBeSyncDocuments[index]);
                    }
                }
            }
        } catch (error) {
            showError(error);
        } finally {
            this.syncRunning = false;
            this.notify({ eventName: 'syncState', state: 'finished' });
        }
    }, 1000);
}
export const syncService = new SyncService();
