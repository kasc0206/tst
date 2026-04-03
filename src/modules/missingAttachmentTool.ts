type ScanResult = {
    scannedItems: number;
    itemsWithMissingAttachments: number;
    movedItems: number;
};

type CleanupResult = {
    checkedItems: number;
    removedItems: number;
};

const TARGET_COLLECTION_NAME = "缺失附件";

export class MissingAttachmentTool {
    private static running = false;

    static registerMenu(win: _ZoteroTypes.MainWindow) {
        const menuID = `${addon.data.config.addonRef}-scan-missing-attachments`;
        ztoolkit.Menu.register("menuTools", {
            tag: "menuitem",
            id: menuID,
            label: "扫描缺失附件并归类",
            commandListener: () => {
                void this.scanAndClassify();
            },
        });

        const cleanupMenuID = `${addon.data.config.addonRef}-cleanup-missing-attachments`;
        ztoolkit.Menu.register("menuTools", {
            tag: "menuitem",
            id: cleanupMenuID,
            label: "清理“缺失附件”分类",
            commandListener: () => {
                void this.cleanupCategory();
            },
        });

        ztoolkit.log(
            "menu registered",
            win.location.href,
            menuID,
            cleanupMenuID,
        );
    }

    static async scanAndClassify(): Promise<void> {
        if (this.running) {
            new ztoolkit.ProgressWindow(addon.data.config.addonName)
                .createLine({
                    text: "任务正在进行中，请稍后重试。",
                    type: "default",
                })
                .show();
            return;
        }

        this.running = true;

        const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
            closeOnClick: true,
            closeTime: -1,
        })
            .createLine({
                text: "开始扫描 Zotero 库中的缺失附件...",
                type: "default",
                progress: 0,
            })
            .show();

        try {
            const result = await this.scanLibraries();

            popup.changeLine({
                progress: 100,
                type: "success",
                text: `扫描完成：共扫描 ${result.scannedItems} 条，识别 ${result.itemsWithMissingAttachments} 条缺失附件，新增归类 ${result.movedItems} 条。`,
            });
            popup.startCloseTimer(8000);
        } catch (e) {
            ztoolkit.log("scan failed", e);
            popup.changeLine({
                progress: 100,
                type: "error",
                text: "扫描失败，请打开 Zotero 调试日志查看详细错误。",
            });
            popup.startCloseTimer(10000);
        } finally {
            this.running = false;
        }
    }

    static async cleanupCategory(): Promise<void> {
        if (this.running) {
            new ztoolkit.ProgressWindow(addon.data.config.addonName)
                .createLine({
                    text: "任务正在进行中，请稍后重试。",
                    type: "default",
                })
                .show();
            return;
        }

        this.running = true;

        const popup = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
            closeOnClick: true,
            closeTime: -1,
        })
            .createLine({
                text: "开始清理“缺失附件”分类...",
                type: "default",
                progress: 0,
            })
            .show();

        try {
            const result = await this.cleanupLibraries();
            popup.changeLine({
                progress: 100,
                type: "success",
                text: `清理完成：检查 ${result.checkedItems} 条，移出 ${result.removedItems} 条。`,
            });
            popup.startCloseTimer(8000);
        } catch (e) {
            ztoolkit.log("cleanup failed", e);
            popup.changeLine({
                progress: 100,
                type: "error",
                text: "清理失败，请打开 Zotero 调试日志查看详细错误。",
            });
            popup.startCloseTimer(10000);
        } finally {
            this.running = false;
        }
    }

    private static async scanLibraries(): Promise<ScanResult> {
        const result: ScanResult = {
            scannedItems: 0,
            itemsWithMissingAttachments: 0,
            movedItems: 0,
        };

        const libraries = Zotero.Libraries.getAll().filter(
            (lib: any) => !lib?.libraryType || lib.libraryType !== "feed",
        );

        for (const library of libraries) {
            const libraryID = library.libraryID as number;
            const collection = await this.ensureCollection(
                libraryID,
                TARGET_COLLECTION_NAME,
            );

            const search = new Zotero.Search();
            (search as any).libraryID = libraryID;
            search.addCondition("itemType", "isNot", "attachment");
            search.addCondition("itemType", "isNot", "note");
            search.addCondition("itemType", "isNot", "annotation");
            search.addCondition("deleted", "false");

            const itemIDs = await search.search();

            for (const itemID of itemIDs) {
                const item = (await Zotero.Items.getAsync(itemID)) as Zotero.Item;
                if (!item || !item.isRegularItem()) {
                    continue;
                }

                result.scannedItems += 1;

                const hasMissingAttachment = await this.itemHasMissingAttachment(item);
                if (!hasMissingAttachment) {
                    continue;
                }

                result.itemsWithMissingAttachments += 1;

                const collectionIDs = item.getCollections();
                if (!collectionIDs.includes(collection.id)) {
                    item.setCollections([...collectionIDs, collection.id]);
                    await item.saveTx();
                    result.movedItems += 1;
                }
            }
        }

        return result;
    }

    private static async cleanupLibraries(): Promise<CleanupResult> {
        const result: CleanupResult = {
            checkedItems: 0,
            removedItems: 0,
        };

        const libraries = Zotero.Libraries.getAll().filter(
            (lib: any) => !lib?.libraryType || lib.libraryType !== "feed",
        );

        for (const library of libraries) {
            const libraryID = library.libraryID as number;
            const collection = this.findCollection(libraryID, TARGET_COLLECTION_NAME);
            if (!collection) {
                continue;
            }

            const itemIDs = collection.getChildItems().map((item) => item.id);
            for (const itemID of itemIDs) {
                const item = (await Zotero.Items.getAsync(itemID)) as Zotero.Item;
                if (!item || !item.isRegularItem()) {
                    continue;
                }

                result.checkedItems += 1;

                const hasMissingAttachment = await this.itemHasMissingAttachment(item);
                if (hasMissingAttachment) {
                    continue;
                }

                const remainingCollectionIDs = item
                    .getCollections()
                    .filter((id) => id !== collection.id);
                item.setCollections(remainingCollectionIDs);
                await item.saveTx();
                result.removedItems += 1;
            }
        }

        return result;
    }

    private static async ensureCollection(
        libraryID: number,
        collectionName: string,
    ): Promise<Zotero.Collection> {
        const existing = this.findCollection(libraryID, collectionName);
        if (existing) {
            return existing;
        }

        const collection = new Zotero.Collection();
        (collection as any).libraryID = libraryID;
        collection.name = collectionName;
        await collection.saveTx();
        return collection;
    }

    private static findCollection(
        libraryID: number,
        collectionName: string,
    ): Zotero.Collection | undefined {
        const collections = Zotero.Collections.getByLibrary(libraryID) as Array<
            Zotero.Collection
        >;
        return collections.find((col) => col.name === collectionName);
    }

    private static async itemHasMissingAttachment(
        item: Zotero.Item,
    ): Promise<boolean> {
        const attachmentIDs = item.getAttachments();
        if (!attachmentIDs.length) {
            return false;
        }

        for (const attachmentID of attachmentIDs) {
            const attachment = (await Zotero.Items.getAsync(attachmentID)) as any;
            if (!attachment || !attachment.isAttachment?.()) {
                continue;
            }

            // Linked URL does not correspond to a local file and should not be treated as missing.
            if (
                attachment.attachmentLinkMode ===
                Zotero.Attachments.LINK_MODE_LINKED_URL
            ) {
                continue;
            }

            const exists = await this.attachmentFileExists(attachment);
            if (!exists) {
                return true;
            }
        }

        return false;
    }

    private static async attachmentFileExists(
        attachment: any,
    ): Promise<boolean> {
        if (typeof attachment.fileExists === "function") {
            try {
                return Boolean(await attachment.fileExists());
            } catch (e) {
                ztoolkit.log("fileExists() failed", attachment?.id, e);
            }
        }

        const path =
            (typeof attachment.getFilePath === "function" &&
                attachment.getFilePath()) ||
            (typeof attachment.getFilePathAsync === "function" &&
                (await attachment.getFilePathAsync()));

        return Boolean(path);
    }
}
