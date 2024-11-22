import { ApplicationSettings, File, ImageSource, Observable, ObservableArray, path } from '@nativescript/core';
import dayjs from 'dayjs';
import { ColorPaletteData, OCRData, QRCodeData, Quad, Quads, cropDocumentFromFile } from 'plugin-nativeprocessor';
import {
    DocumentAddedEventData,
    DocumentFolderAddedEventData,
    DocumentMovedFolderEventData,
    DocumentPageDeletedEventData,
    DocumentPageUpdatedEventData,
    DocumentPagesAddedEventData,
    DocumentUpdatedEventData,
    DocumentsService,
    FOLDER_COLOR_SEPARATOR,
    FolderUpdatedEventData,
    sql
} from '~/services/documents';
import type { MatricesTypes, Matrix } from '~/utils/color_matrix';
import { getFormatedDateForFilename } from '~/utils/utils.common';
import {
    DOCUMENT_NAME_FORMAT,
    EVENT_DOCUMENT_ADDED,
    EVENT_DOCUMENT_MOVED_FOLDER,
    EVENT_DOCUMENT_PAGES_ADDED,
    EVENT_DOCUMENT_PAGE_DELETED,
    EVENT_DOCUMENT_PAGE_UPDATED,
    EVENT_DOCUMENT_UPDATED,
    EVENT_FOLDER_ADDED,
    EVENT_FOLDER_UPDATED,
    IMG_FORMAT,
    SEPARATOR,
    SETTINGS_DOCUMENT_NAME_FORMAT,
    getImageExportSettings
} from '../utils/constants';
import SqlQuery from '@akylas/kiss-orm/dist/Queries/SqlQuery';
import { doInBatch } from '@shared/utils/batch';
import { isString } from '@nativescript/core/utils';

export interface ImportImageData {
    imagePath?: string;
    imageWidth?: number;
    imageHeight?: number;
    imageRotation?: number;
    quads?: Quads;
    qrcode?: QRCodeData;
    undos?: any[];
    redos?: any[];
}

export interface ImageConfig {
    colorType?: MatricesTypes;
    colorMatrix?: Matrix;
    rotation?: number;
}

export class Tag {
    public readonly id!: string;
    public name: string;
}

export interface IDocFolder {
    id: number;
    name: string;
    color?: string;
    modifiedDate?: number;
    size?: number;
    count?: number;
}
export class DocFolder {
    public readonly id!: number;
    public name: string;
    public color?: string;
    modifiedDate?: number;
    size?: number;
    count?: number;
    async save(data: Partial<IDocFolder> = {}, notify = true) {
        if (!data.modifiedDate) {
            data.modifiedDate = Date.now();
        }
        await documentsService.folderRepository.update(this, data);
        Object.assign(this, data);
        if (notify) {
            documentsService.notify({ eventName: EVENT_FOLDER_UPDATED, folder: this } as FolderUpdatedEventData);
        }
    }

    static fromJSON(jsonObj: DocFolder) {
        const folder = new DocFolder();
        Object.assign(folder, jsonObj);
        return folder;
    }

    toString() {
        const { count, size, ...toStringify } = this;
        return JSON.stringify(toStringify);
    }

    toJSONObject() {
        return JSON.parse(this.toString());
    }
}

export interface Document {
    id: string;
    createdDate: number;
    modifiedDate: number;
    name?: string;
    tags: string[];
    folders: number[];
    _synced: number;
    pagesOrder: string[];
    pages?: OCRPage[];
    extra?: DocumentExtra;
}

let documentsService: DocumentsService;

export function setDocumentsService(service: DocumentsService) {
    documentsService = service;
}
export function getDocumentsService() {
    return documentsService;
}

export interface DocumentExtra {
    [k: string]:
        | string
        | {
              type: string;
              value: any;
          };
}

export class OCRDocument extends Observable implements Document {
    // id: string;
    createdDate: number;
    modifiedDate: number;
    name?: string;
    tags: string[];
    folders: number[];
    _synced: number;

    extra?: DocumentExtra;

    pagesOrder: string[];

    #observables: ObservableArray<OCRPage>;
    pages: OCRPage[];

    constructor(public id: string) {
        super();
        // this.id = id;
    }

    static fromJSON(jsonObj: Document) {
        const { extra, id, pages, ...others } = jsonObj;
        const doc = new OCRDocument(id);
        Object.assign(doc, {
            extra: isString(extra) ? JSON.parse(extra as any as string) : extra,
            pages: pages.map((p) => OCRPage.fromJSON(p)),
            ...others
        });
        return doc;
    }

    static async createDocument(pagesData?: PageData[], folder?: DocFolder) {
        const date = dayjs();
        const docId = date.valueOf() + '';
        const name = getFormatedDateForFilename(date.valueOf(), ApplicationSettings.getString(SETTINGS_DOCUMENT_NAME_FORMAT, DOCUMENT_NAME_FORMAT), false);
        // DEV_LOG && console.log('createDocument', docId);
        const doc = await documentsService.documentRepository.createDocument({ id: docId, name, ...(folder ? { folders: [folder.id] } : {}) } as any);
        await doc.addPages(pagesData, false);
        // DEV_LOG && console.log('createDocument pages added');
        // no need to notify on create. Will be done in documentAdded
        await doc.save({}, false, false);
        documentsService.notify({ eventName: EVENT_DOCUMENT_ADDED, doc, folder } as DocumentAddedEventData);
        return doc;
    }

    get folderPath() {
        return documentsService.dataFolder.getFolder(this.id);
    }

    async addPage(pageData: PageData, index: number = this.pages.length) {
        const docId = this.id;
        const dataFolderPath = documentsService.dataFolder.path;
        const docData = documentsService.dataFolder.getFolder(docId);
        const { id, image, imagePath, sourceImagePath, ...otherPageData } = pageData;
        const pageId = id || Date.now() + '_' + index;
        // const page = new OCRPage(pageId, docId);
        const pageFileData = docData.getFolder(pageId);
        const attributes = { ...otherPageData, id: pageId, document_id: docId } as OCRPage;
        attributes.imagePath = path.join(pageFileData.path, 'image' + '.' + IMG_FORMAT);
        if (imagePath) {
            if (imagePath !== attributes.imagePath) {
                const file = File.fromPath(imagePath);
                await file.copy(attributes.imagePath);
            }
        } else if (image) {
            const imageExportSettings = getImageExportSettings();
            await new ImageSource(image).saveToFileAsync(attributes.imagePath, imageExportSettings.imageFormat, imageExportSettings.imageQuality);
        } else {
            return;
        }
        attributes.size = File.fromPath(attributes.imagePath).size;
        DEV_LOG && console.log('add single page', attributes.imagePath, imagePath, sourceImagePath, image, attributes.size, otherPageData);
        if (sourceImagePath) {
            let baseName = sourceImagePath
                .split(SEPARATOR)
                .pop()
                .replace(/%[a-zA-Z\d]{2}/, '');
            if (!baseName.endsWith(IMG_FORMAT)) {
                baseName += '.' + IMG_FORMAT;
            }
            const actualSourceImagePath = path.join(pageFileData.path, baseName);
            attributes.sourceImagePath = actualSourceImagePath;
            if (actualSourceImagePath !== sourceImagePath) {
                const file = File.fromPath(sourceImagePath);
                await file.copy(actualSourceImagePath);
            }
        }
        // we add 1000 to each pageIndex so that we can reorder them
        // if (!attributes.pageIndex) {
        //     attributes.pageIndex = index + 1000;
        // }
        const addedPage = await documentsService.pageRepository.createPage(attributes, dataFolderPath);
        // Object.assign(pageData, { ...pageData, pageIndex: pages.length + 1000 });

        //using saved image to disk
        if (this.pages) {
            this.pages.splice(index, 0, addedPage);
        } else {
            this.pages = [addedPage];
        }
        if (this.#observables) {
            this.#observables.splice(index, 0, addedPage);
        }
        documentsService.notify({ eventName: EVENT_DOCUMENT_PAGES_ADDED, pages: [addedPage], doc: this } as DocumentPagesAddedEventData);
    }

    async addPages(pagesData?: PageData[], notify = true) {
        const dataFolderPath = documentsService.dataFolder.path;
        DEV_LOG && console.log('addPages', dataFolderPath, JSON.stringify(pagesData));
        if (pagesData) {
            const docId = this.id;
            const docData = this.folderPath;
            const { length } = pagesData;
            const pageStartId = Date.now();
            const imageExportSettings = getImageExportSettings();
            const pages = await doInBatch(pagesData, async (data, index) => {
                const { id, image, imagePath, sourceImage, sourceImagePath, ...pageData } = data;
                const pageId = id || pageStartId + '_' + index;
                // const page = new OCRPage(pageId, docId);
                const pageFileData = docData.getFolder(pageId);
                const attributes = { ...pageData, id: pageId, document_id: docId } as OCRPage;
                attributes.imagePath = path.join(pageFileData.path, 'image' + '.' + imageExportSettings.imageFormat);
                DEV_LOG && console.log('add page', pageId, attributes.imagePath, imagePath, sourceImagePath, image, JSON.stringify(pageData));
                if (imagePath) {
                    // if the same nothing to do, must be while syncing
                    if (imagePath !== attributes.imagePath) {
                        const file = File.fromPath(imagePath);
                        await file.copy(attributes.imagePath);
                    }
                } else if (image) {
                    const imageSource = new ImageSource(image);
                    await imageSource.saveToFileAsync(attributes.imagePath, imageExportSettings.imageFormat, imageExportSettings.imageQuality);
                } else {
                    return;
                }
                attributes.size = File.fromPath(attributes.imagePath).size;
                if (sourceImage) {
                    const baseName = dayjs().format('yyyyMMddHHmmss') + '.' + imageExportSettings.imageFormat;
                    // }
                    const actualSourceImagePath = path.join(pageFileData.path, baseName);

                    const imageSource = new ImageSource(sourceImage);
                    await imageSource.saveToFileAsync(actualSourceImagePath, imageExportSettings.imageFormat, imageExportSettings.imageQuality);
                    attributes.sourceImagePath = actualSourceImagePath;
                } else if (sourceImagePath) {
                    let baseName = sourceImagePath
                        .replace(/%252F/g, SEPARATOR) // for Android content:// paths
                        .split(SEPARATOR)
                        .pop()
                        .replace(/%[a-zA-Z\d]{2}/, '');
                    if (!baseName.endsWith(imageExportSettings.imageFormat)) {
                        baseName += '.' + imageExportSettings.imageFormat;
                    }
                    const actualSourceImagePath = path.join(pageFileData.path, baseName);
                    // if the same nothing to do, must be while syncing
                    attributes.sourceImagePath = actualSourceImagePath;
                    if (actualSourceImagePath !== sourceImagePath) {
                        const file = File.fromPath(sourceImagePath);
                        await file.copy(actualSourceImagePath);
                    }
                }
                if (id) {
                    try {
                        const page = await documentsService.pageRepository.get(id);
                        if (page) {
                            const { id, ...toUpdate } = attributes;
                            return documentsService.pageRepository.update(page, toUpdate);
                        }
                    } catch (error) {}
                }
                return documentsService.pageRepository.createPage(attributes, dataFolderPath);
            });
            // for (let index = 0; index < length; index++) {}
            // DEV_LOG && console.log('addPages done', JSON.stringify(pages));
            if (this.pages) {
                this.pages.push(...pages);
            } else {
                this.pages = pages;
            }
            // this.save();
            if (this.#observables) {
                this.#observables.push(...pages);
            }
            if (notify) {
                documentsService.notify({ eventName: EVENT_DOCUMENT_PAGES_ADDED, pages, doc: this } as DocumentPagesAddedEventData);
            }
        }
    }

    // async updatePagesOrder() {
    //     this.save({
    //         pagesOrder: this.pages.map((p) => p.id)
    //     });
    // }

    async removeFromDisk() {
        const docData = this.folderPath;
        return docData.remove();
    }

    async deletePage(pageIndex: number) {
        const removed = this.pages.splice(pageIndex, 1);
        DEV_LOG && console.log('delete page', pageIndex);
        if (this.pages.length === 0) {
            return documentsService.deleteDocuments([this]);
        }
        if (this.#observables) {
            this.#observables.splice(pageIndex, 1);
        }
        await documentsService.pageRepository.delete(removed[0]);
        const docData = this.folderPath;
        for (let index = 0; index < removed.length; index++) {
            const removedPage = removed[index];
            await docData.getFolder(removedPage.id).remove();
        }
        documentsService.notify({ eventName: EVENT_DOCUMENT_PAGE_DELETED, doc: this, pageIndex } as DocumentPageDeletedEventData);
        await this.save({}, true, false);
        return this;
    }

    async updatePage(pageIndex, data: Partial<Page>, imageUpdated = false) {
        //compute diff update
        const page = this.pages[pageIndex];
        if (page) {
            DEV_LOG && console.log('updatePage', pageIndex, JSON.stringify(data), page.toString());
            if (Object.keys(data).length === 0) {
                return;
            }
            await documentsService.pageRepository.update(page, data);
            // we save the document so that the modifiedDate gets changed
            // no need to notify though
            await this.save({}, true, true);
            this.onPageUpdated(pageIndex, page, imageUpdated);
        }
        DEV_LOG && console.log('updatePage done', pageIndex);
    }
    async movePage(oldIndex: any, newIndex: any) {
        // first we need to find the new pageIndex
        // let pageIndex;
        // if (newIndex === 0) {
        //     pageIndex = this.pages[0].pageIndex - 1;
        // } else {
        //     pageIndex = this.pages[newIndex].pageIndex + 1;
        // }
        // await this.updatePage(oldIndex, {
        //     pageIndex
        // });

        const item = this.pages[oldIndex];
        this.pages.splice(oldIndex, 1);
        this.pages.splice(newIndex, 0, item);
        if (this.#observables) {
            const item = this.#observables.getItem(oldIndex);
            this.#observables.splice(oldIndex, 1);
            this.#observables.splice(newIndex, 0, item);
        }
        return this.save({}, true);
    }
    onPageUpdated(pageIndex: number, page: OCRPage, imageUpdated = false) {
        documentsService.notify({ eventName: EVENT_DOCUMENT_PAGE_UPDATED, doc: this, pageIndex, imageUpdated } as DocumentPageUpdatedEventData);
    }
    getObservablePages() {
        if (!this.#observables) {
            const { pages } = this;
            this.#observables = new ObservableArray(pages);
            // const handler = (event: EventData & { pageIndex: number }) => {
            //     this.#observables.setItem(event.pageIndex, this.#observables.getItem(event.pageIndex));
            // };
            // this.#_observablesListeners.push(handler);
            // this.on('pageUpdated', handler);
        }
        return this.#observables;
    }

    async save(data: Partial<OCRDocument> = {}, updateModifiedDate = false, notify = true) {
        if (data.pagesOrder) {
            this.pages = this.pages.sort(function (a, b) {
                return data.pagesOrder.indexOf(a.id) - data.pagesOrder.indexOf(b.id);
            });
            if (this.#observables) {
                this.#observables.splice(0, this.pages.length, ...this.pages);
            }
        } else {
            data.pagesOrder = this.pages.map((p) => p.id);
        }
        await documentsService.documentRepository.update(this, data, updateModifiedDate);
        if (notify) {
            documentsService.notify({ eventName: EVENT_DOCUMENT_UPDATED, doc: this, updateModifiedDate } as DocumentUpdatedEventData);
        }
    }

    toString() {
        return JSON.stringify({ db_version: DocumentsService.DB_VERSION, ...this }, (key, value) => (key !== '_synced' && key.startsWith('_') ? undefined : value));
    }

    toJSONObject() {
        return JSON.parse(this.toString());
    }

    async updatePageCrop(pageIndex: number, quad: Quad) {
        const page = this.pages[pageIndex];
        DEV_LOG && console.log('updatePageCrop', this.id, pageIndex, quad, page.imagePath);
        const file = File.fromPath(page.imagePath);
        const imageExportSettings = getImageExportSettings();
        const images = await cropDocumentFromFile(page.sourceImagePath, [quad], {
            transforms: page.transforms,
            saveInFolder: file.parent.path,
            fileName: file.name,
            compressFormat: imageExportSettings.imageFormat,
            compressQuality: imageExportSettings.imageQuality
        });
        const image = images[0];
        // const croppedImagePath = page.imagePath;
        // await new ImageSource(images[0]).saveToFileAsync(croppedImagePath, IMG_FORMAT, IMG_COMPRESS);
        // if (__IOS__) {
        //     // TODO: fix why do we need to clear the whole cache? wrong cache key?
        //     getImagePipeline().clearCaches();
        // } else {
        //     getImagePipeline().evictFromCache(croppedImagePath);
        // }
        await this.updatePage(
            pageIndex,
            {
                crop: quad,
                width: image.width,
                height: image.height,
                size: file.size
            },
            true
        );
        //we remove from cache so that everything gets updated
        // recycleImages(images);
    }
    async updatePageTransforms(pageIndex: number, transforms: string, optionalUpdates = {}) {
        const page = this.pages[pageIndex];
        DEV_LOG && console.log('updatePageTransforms', this.id, pageIndex, this.pages.length, page?.imagePath, transforms);
        if (!page) {
            return;
        }
        const file = File.fromPath(page.imagePath);
        const imageExportSettings = getImageExportSettings();
        if (transforms === page.transforms) {
            await this.updatePage(
                pageIndex,
                {
                    ...optionalUpdates
                },
                false
            );
        } else {
            const images = await cropDocumentFromFile(page.sourceImagePath, [page.crop], {
                transforms,
                saveInFolder: file.parent.path,
                fileName: file.name,
                compressFormat: imageExportSettings.imageFormat,
                compressQuality: imageExportSettings.imageQuality
            });
            const image = images[0];

            await this.updatePage(
                pageIndex,
                {
                    transforms,
                    width: image.width,
                    height: image.height,
                    size: file.size,
                    ...optionalUpdates
                },
                true
            );
        }
    }
    async setFolder({ folderId, folderName, notify = true }: { folderId?: number; folderName?: string; notify?: boolean }) {
        console.log('setFolder', folderId, this.folders);
        const { folderRepository } = documentsService;
        const { db } = documentsService;
        let oldFolderId: number;
        if (this.folders?.length) {
            // const [name, color] = this.folders[0].split(FOLDER_COLOR_SEPARATOR);
            // oldFolder = { name, color };
            oldFolderId = this.folders[0];
        }
        let folder: DocFolder;
        // const [folderName, folderColor] = (folderAndColorName || '').split(FOLDER_COLOR_SEPARATOR);
        if (folderId || folderName?.length) {
            try {
                folder = (await folderRepository.search({ where: folderId ? sql`id=${folderId}` : sql`name=${folderName}` }))[0];
            } catch (error) {
                console.error('setFolder', error, error.stack);
            }
            if (!folder) {
                folder = await folderRepository.create({ id: folderId || Date.now(), name: folderName });
                if (notify) {
                    documentsService.notify({ eventName: EVENT_FOLDER_ADDED, folder } as DocumentFolderAddedEventData);
                }
            }
        }

        if (folder) {
            await db.query(sql` DELETE FROM DocumentsFolders where document_id=${this.id} AND folder_id IS NOT ${folder.id}`);
            const relation = await db.query(sql` SELECT * FROM DocumentsFolders WHERE "document_id" = ${this.id} AND "folder_id" = ${folder.id}`);
            if (relation.length === 0) {
                await db.query(sql` INSERT INTO DocumentsFolders ( document_id, folder_id ) VALUES(${this.id}, ${folder.id})`);
            }
            this.folders = [folder.id];
        } else {
            await db.query(sql` DELETE FROM DocumentsFolders where document_id=${this.id}`);
            delete this.folders;
        }
        this._synced = 0;
        if (notify) {
            documentsService.notify({ eventName: EVENT_DOCUMENT_MOVED_FOLDER, doc: this, folder, oldFolderId } as DocumentMovedFolderEventData);
        }
    }

    async removeFromFolder() {
        await documentsService.db.query(sql` DELETE FROM DocumentsFolders where document_id=${this.id}`);
    }
}

export interface Page {
    id: string;
    createdDate: number;
    modifiedDate?: number;
    name?: string;
    document_id: string;

    transforms?: string;
    colorType?: MatricesTypes;
    colorMatrix?: Matrix;
    brightness?: number;
    contrast?: number;
    rotation: number;
    crop: Quad;
    // pageIndex: number;
    scale: number;
    width: number;
    height: number;
    size: number;
    sourceImagePath: string;
    sourceImageWidth: number;
    sourceImageHeight: number;
    sourceImageRotation: number;
    imagePath: string;

    ocrData: OCRData;
    qrcode: QRCodeData;
    colors: ColorPaletteData;
}

export interface PageData extends ImageConfig, Partial<Page> {
    bitmap?;
    image?;
    sourceImage?;
}

export class OCRPage extends Observable implements Page {
    id: string;
    createdDate: number;
    modifiedDate?: number;
    name?: string;
    document_id: string;

    colorType?: MatricesTypes;
    colorMatrix?: Matrix;

    brightness?: number;
    contrast?: number;

    rotation: number = 0;
    scale: number = 1;

    crop: Quad;

    transforms?: string;

    // pageIndex: number;
    width: number;
    height: number;
    size: number;

    sourceImagePath: string;
    sourceImageWidth: number;
    sourceImageHeight: number;
    sourceImageRotation: number;

    imagePath: string;

    ocrData: OCRData;
    qrcode: QRCodeData;
    colors: ColorPaletteData;

    constructor(id: string, docId: string) {
        super();
        this.id = id;
        this.document_id = docId;
    }
    toString() {
        return JSON.stringify(this, (key, value) => (key !== '_synced' && key.startsWith('_') ? undefined : value));
    }

    toJSONObject() {
        return JSON.parse(this.toString());
    }
    static fromJSON(jsonObj: Page) {
        const page = new OCRPage(jsonObj.id, jsonObj.document_id);
        // DEV_LOG && console.log('OCRPage', 'fromJSON', Object.keys(jsonObj));
        Object.assign(page, jsonObj);
        return page;
    }
}
