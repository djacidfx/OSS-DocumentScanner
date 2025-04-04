<script lang="ts">
    import { CheckBox } from '@nativescript-community/ui-checkbox';
    import { Label } from '@nativescript-community/ui-label';
    import { prompt } from '@nativescript-community/ui-material-dialogs';
    import { TextField, TextFieldProperties } from '@nativescript-community/ui-material-textfield';
    import { ApplicationSettings, Color, ObservableArray, View } from '@nativescript/core';
    import { showError } from '@shared/utils/showError';
    import { closeModal } from '@shared/utils/svelte/ui';
    import { Template } from 'svelte-native/components';
    import { get, writable } from 'svelte/store';
    import { l, lc } from '~/helpers/locale';
    import { getPDFDefaultExportOptions } from '~/services/pdf/PDFCanvas';
    import { LocalFolderPDFSyncServiceOptions } from '~/services/sync/LocalFolderPDFSyncService';
    import { SERVICES_SYNC_COLOR } from '~/services/sync/types';
    import { ALERT_OPTION_MAX_HEIGHT, FILENAME_DATE_FORMAT, FILENAME_USE_DOCUMENT_NAME, SETTINGS_FILE_NAME_FORMAT, SETTINGS_FILE_NAME_USE_DOCUMENT_NAME } from '~/utils/constants';
    import { checkOrDownloadOCRLanguages, createView, getNameFormatHTMLArgs, openLink, pickColor, showAlertOptionSelect, showSliderPopover } from '~/utils/ui';
    import { colors, windowInset } from '~/variables';
    import CActionBar from '../common/CActionBar.svelte';
    import FolderTextView from '../common/FolderTextView.svelte';
    import ListItemAutoSize from '../common/ListItemAutoSize.svelte';
    import OcrSettingsBottomSheet from '../ocr/OCRSettingsBottomSheet.svelte';
    import PdfSyncSettingsView from './PDFSyncSettingsView.svelte';
    // technique for only specific properties to get updated on store change
    $: ({ colorOnSurfaceVariant, colorOutline, colorPrimary } = $colors);

    const tMargin = '4 10 4 10';
    const pdfExportSettings = getPDFDefaultExportOptions();
    export let data: LocalFolderPDFSyncServiceOptions = {} as any;
    const store = writable(
        Object.assign(
            {
                exportOptions: pdfExportSettings,
                autoSync: false,
                enabled: true,
                OCREnabled: false,
                useFoldersStructure: false,
                OCRDataType: 'best',
                OCRLanguages: [],
                fileNameFormat: ApplicationSettings.getString(SETTINGS_FILE_NAME_FORMAT, FILENAME_DATE_FORMAT),
                useDocumentName: ApplicationSettings.getBoolean(SETTINGS_FILE_NAME_USE_DOCUMENT_NAME, FILENAME_USE_DOCUMENT_NAME),
                color: SERVICES_SYNC_COLOR['folder_pdf'] as string | Color
            },
            data
        )
    );
    DEV_LOG && console.log('FolderImageSyncSettings', JSON.stringify(data), JSON.stringify(get(store)));
    // let folderPathName = data.folderPathName;
    const variant = 'outline';

    async function save() {
        const result = get(store);
        DEV_LOG && console.log('save', JSON.stringify(result));
        if (result.localFolderPath) {
            if (result.OCREnabled && result.OCRLanguages.length) {
                await checkOrDownloadOCRLanguages({
                    dataType: result.OCRDataType,
                    languages: result.OCRLanguages,
                    shouldConfirm: false
                });
            }
            closeModal(result);
        } else {
            showError(lc('missing_export_folder'), { showAsSnack: true });
        }
    }

    const items = new ObservableArray([
        {
            type: 'color'
        },
        {
            type: 'switch',
            id: 'enabled',
            title: lc('enabled'),
            value: $store.enabled
        },
        { type: 'selectFolder', text: $store.localFolderPath },
        {
            type: 'switch',
            id: 'autoSync',
            title: lc('auto_sync'),
            description: lc('local_auto_sync_desc'),
            value: $store.autoSync
        },
        {
            type: 'switch',
            id: 'useDocumentName',
            title: lc('filename_use_document_name'),
            value: $store.useDocumentName
        },
        {
            id: 'setting',
            key: 'fileNameFormat',
            useHTML: true,
            title: lc('filename_date_format'),
            description: lc('filename_date_format_desc'),
            full_description: lc('filename_date_format_fulldesc', ...getNameFormatHTMLArgs()),
            onLinkTap: ({ link }) => {
                openLink(link);
            },
            valueType: 'string',
            textFieldProperties: {
                autocapitalizationType: 'none',
                autocorrect: false
            } as TextFieldProperties,
            rightValue: () => $store.fileNameFormat,
            type: 'prompt'
        },
        {
            type: 'switch',
            id: 'useFoldersStructure',
            title: lc('use_folder_structure'),
            description: lc('use_folder_structure_desc'),
            value: $store.useFoldersStructure
        },
        {
            type: 'sectionheader',
            title: lc('pdf_settings')
        },
        {
            type: 'pdfoptions'
        },
        {
            type: 'sectionheader',
            title: lc('ocr_settings')
        },
        {
            type: 'switch',
            id: 'OCREnabled',
            title: lc('ocr_enabled'),
            value: $store.OCREnabled
        },
        {
            type: 'ocroptions'
        }
    ]);

    function getTitle(item) {
        return item.title;
    }
    function getDescription(item) {
        return typeof item.description === 'function' ? item.description(item) : item.description;
    }
    function updateItem(item, key = 'key') {
        const index = items.findIndex((it) => it[key] === item[key]);
        if (index !== -1) {
            items.setItem(index, item);
        }
    }

    let checkboxTapTimer;
    function clearCheckboxTimer() {
        if (checkboxTapTimer) {
            clearTimeout(checkboxTapTimer);
            checkboxTapTimer = null;
        }
    }
    let ignoreNextOnCheckBoxChange = false;
    async function onCheckBox(item, event, pdfOption?: string) {
        if (ignoreNextOnCheckBoxChange || item.value === event.value) {
            return;
        }
        const value = event.value;
        item.value = value;
        clearCheckboxTimer();
        DEV_LOG && console.log('onCheckBox', item.id, value);
        try {
            ignoreNextOnCheckBoxChange = true;
            DEV_LOG && console.log('updating setting for checkbox', item.id, item.key, value);
            if (pdfOption) {
                $store.exportOptions[pdfOption] = value;
            } else {
                $store[item.key || item.id] = value;
            }
        } catch (error) {
            showError(error);
        } finally {
            ignoreNextOnCheckBoxChange = false;
        }
    }
    async function onTap(item, event) {
        try {
            if (item.type === 'checkbox' || item.type === 'switch') {
                // we dont want duplicate events so let s timeout and see if we clicking diretly on the checkbox
                const checkboxView: CheckBox = ((event.object as View).parent as View).getViewById('checkbox');
                clearCheckboxTimer();
                checkboxTapTimer = setTimeout(() => {
                    checkboxView.checked = !checkboxView.checked;
                }, 10);
                return;
            }
            switch (item.id) {
                case 'store_setting':
                case 'setting': {
                    if (item.type === 'prompt') {
                        const result = await prompt({
                            title: getTitle(item),
                            message: item.useHTML ? item.description : item.full_description || item.description,
                            okButtonText: l('save'),
                            cancelButtonText: l('cancel'),
                            autoFocus: true,
                            textFieldProperties: item.textFieldProperties,
                            defaultText: (typeof item.rightValue === 'function' ? item.rightValue() : item.default) + '',
                            view: item.useHTML
                                ? createView(
                                      Label,
                                      {
                                          padding: '10 20 0 20',
                                          textWrap: true,
                                          color: colorOnSurfaceVariant as any,
                                          html: item.full_description || item.description
                                      },
                                      item.onLinkTap
                                          ? {
                                                linkTap: item.onLinkTap
                                            }
                                          : undefined
                                  )
                                : undefined
                        });
                        DEV_LOG && console.log('prompt result', item.key, item.valueType, result);
                        if (result && !!result.result && result.text.length > 0) {
                            if (item.valueType === 'string') {
                                $store[item.key] = result.text;
                            } else {
                                $store[item.key] = parseInt(result.text, 10);
                            }
                            updateItem(item);
                        }
                    } else if (item.type === 'slider') {
                        DEV_LOG && console.log('showSlidersPopover', event.object, item.currentValue());
                        await showSliderPopover({
                            anchor: event.object,
                            value: item.currentValue(),
                            ...item,
                            onChange(value) {
                                if (item.transformValue) {
                                    value = item.transformValue(value, item);
                                } else {
                                    value = Math.round(value / item.step) * item.step;
                                }
                                if (item.valueType === 'string') {
                                    $store[item.key] = value + '';
                                } else {
                                    $store[item.key] = value;
                                }
                                updateItem(item);
                            }
                        });
                    } else {
                        const result = await showAlertOptionSelect(
                            {
                                height: Math.min(item.values.length * 56, ALERT_OPTION_MAX_HEIGHT),
                                rowHeight: item.autoSizeListItem ? undefined : 56,
                                ...item,
                                options: item.values.map((k) => ({
                                    name: k.title || k.name,
                                    data: k.value,
                                    boxType: 'circle',
                                    type: 'checkbox',
                                    value: (item.currentValue?.() ?? item.currentValue) === k.value
                                }))
                            },
                            {
                                title: item.title,
                                message: item.full_description
                            }
                        );
                        DEV_LOG && console.log('result?.data', result?.data);
                        if (result?.data !== undefined) {
                            if (item.onResult) {
                                item.onResult(result.data);
                            } else {
                                if (item.valueType === 'string') {
                                    $store[item.key] = result?.data;
                                } else {
                                    $store[item.key] = parseInt(result?.data, 10);
                                }
                            }
                            updateItem(item);
                        }
                    }

                    break;
                }
            }
        } catch (err) {
            showError(err);
        }
    }
    function selectTemplate(item, index, items) {
        if (item.type) {
            if (item.type === 'prompt' || item.type === 'slider') {
                return 'default';
            }
            return item.type;
        }
        if (item.icon) {
            return 'leftIcon';
        }
        return 'default';
    }

    async function changeColor(item, event) {
        try {
            const newColor = await pickColor($store.color, { anchor: event.object });
            if (newColor) {
                $store.color = newColor.hex;
                updateItem(item, 'type');
            }
        } catch (error) {
            showError(error);
        }
    }

    function onTextChange(e) {
        if (e.object.text) {
            (e.object as TextField).setSelection(e.object.text.length);
        }
    }
    async function onFolderSelect(item, event) {
        item.text = $store.localFolderPath = event.text;
        updateItem(item);
    }
</script>

<page actionBarHidden={true}>
    <gridlayout class="pageContent" rows="auto,*">
        <collectionview itemTemplateSelector={selectTemplate} {items} row={1} android:paddingBottom={$windowInset.bottom}>
            <Template key="color" let:item>
                <ListItemAutoSize fontSize={20} subtitle={lc('sync_service_color_desc')} title={lc('color')} on:tap={(e) => changeColor(item, e)}>
                    <absolutelayout backgroundColor={$store.color} borderColor={colorOutline} borderRadius="50%" borderWidth={2} col={1} height={40} marginLeft={10} width={40} />
                </ListItemAutoSize>
            </Template>
            <Template key="textfield" let:item>
                <gridlayout columns="*" margin={tMargin} row={3} rows="auto" on:tap={(e) => item.onTap(item, e)} prop:rightDrawer>
                    <textfield isUserInteractionEnabled={false} text={item.text} {variant} {...item.textFieldProperties} on:loaded={onTextChange} />
                    <mdbutton
                        class="icon-btn"
                        color={colorOnSurfaceVariant}
                        horizontalAlignment="right"
                        isUserInteractionEnabled={false}
                        text={item.icon}
                        variant="text"
                        verticalAlignment="middle"
                        visibility={item.icon ? 'visible' : 'hidden'} />
                </gridlayout>
            </Template>
            <Template key="switch" let:item>
                <ListItemAutoSize leftIcon={item.icon} subtitle={getDescription(item)} title={getTitle(item)} on:tap={(event) => onTap(item, event)}>
                    <switch id="checkbox" checked={item.value} col={1} marginLeft={10} on:checkedChange={(e) => onCheckBox(item, e)} ios:backgroundColor={colorPrimary} />
                </ListItemAutoSize>
            </Template>
            <Template key="pdfoptions" let:item>
                <PdfSyncSettingsView {store} on:uppdate={() => updateItem({ type: 'pdfoptions' }, 'type')} />
            </Template>
            <Template key="selectFolder" let:item>
                <FolderTextView text={item.text} on:folder={(e) => onFolderSelect(item, e)} />
            </Template>
            <Template let:item>
                <ListItemAutoSize rightValue={item.rightValue} subtitle={getDescription(item)} title={getTitle(item)} on:tap={(event) => onTap(item, event)} />
            </Template>
            <Template key="sectionheader" let:item>
                <label class="sectionHeader" text={item.title} />
            </Template>
            <Template key="ocroptions">
                <OcrSettingsBottomSheet onlySettings={true} bind:dataType={$store.OCRDataType} bind:languages={$store.OCRLanguages} />
            </Template>
        </collectionview>
        <CActionBar canGoBack modalWindow={true} title={lc('pdf_sync_settings')}>
            <mdbutton text={lc('save')} variant="text" verticalAlignment="middle" on:tap={save} />
            <!-- <mdbutton class="actionBarButton" text={lc('save')} variant="text" on:tap={save} /> -->
        </CActionBar>
    </gridlayout>
</page>
