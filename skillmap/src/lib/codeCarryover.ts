import { lookupPreviousActivityStates } from "./skillMapUtils";
import { getProjectAsync, saveProjectAsync } from "./workspaceProvider";

export async function carryoverProjectCode(user: UserState, pageSource: string, map: SkillMap, activityId: string, carryoverCode: boolean) {
    const progress = user.mapProgress[pageSource][map.mapId];

    const headerId = progress.activityState[activityId]?.headerId;

    const previous = lookupPreviousActivityStates(user, pageSource, map, activityId);
    const previousHeaderId = previous.find(state => state?.isCompleted &&
        state.maxSteps === state.currentStep)?.headerId;

    if (!headerId || !previousHeaderId) return;

    const previousProject = await getProjectAsync(previousHeaderId);
    const newProject = await getProjectAsync(headerId);

    newProject.text = mergeProjectCode(previousProject.text!, newProject.text!, carryoverCode);

    await saveProjectAsync(newProject);
}


function mergeProjectCode(previousProject: pxt.Map<string>, newProject: pxt.Map<string>, carryoverCode: boolean) {
    return {
        ...newProject,
        ["main.ts"]: carryoverCode ? previousProject["main.ts"] : newProject["main.ts"],
        ["main.py"]: carryoverCode ? previousProject["main.py"] : newProject["main.py"],
        ["main.blocks"]: carryoverCode ? previousProject["main.blocks"] : newProject["main.blocks"],
        [pxt.TILEMAP_JRES]: carryoverCode ?
            mergeJRES(newProject[pxt.TILEMAP_JRES], previousProject[pxt.TILEMAP_JRES]) :
            mergeJRES(previousProject[pxt.TILEMAP_JRES], newProject[pxt.TILEMAP_JRES]),
        [pxt.IMAGES_JRES]: carryoverCode ?
            mergeJRES(newProject[pxt.IMAGES_JRES], previousProject[pxt.IMAGES_JRES]) :
            mergeJRES(previousProject[pxt.IMAGES_JRES], newProject[pxt.IMAGES_JRES])
    };
}

function mergeJRES(previous: string, next: string) {
    if (!previous) return next;
    if (!next) return previous;

    const previousParsed = JSON.parse(previous) as pxt.Map<pxt.JRes | string>;
    const nextParsed = JSON.parse(next) as pxt.Map<pxt.JRes | string>;

    const valueMap: pxt.Map<string> = {};
    const nameMap: pxt.Map<boolean> = {}
    const idMap: pxt.Map<boolean> = {};
    const tileMapping: pxt.Map<string> = {};
    const tilemapEntries: pxt.Map<pxt.JRes> = {};

    const defaultMime = (nextParsed["*"] as pxt.JRes).mimeType;

    // Loop over the base jres so that we can keep track of what ids, names,
    // and values are already present in the project
    for (const key of Object.keys(nextParsed)) {
        if (key === "*") continue;

        const current = nextParsed[key];
        idMap[key] = true;

        let valueString: string;
        let mimeType = defaultMime;
        let isTile = false;

        if (typeof current === "string") {
            valueString = current;
        }
        else {
            valueString = current.data;
            mimeType = current.mimeType;
            isTile = !!current.tilemapTile;

            if (current.displayName) nameMap[current.displayName] = true;
        }

        if (mimeType !== pxt.TILEMAP_MIME_TYPE) {
            const valueKey = mimeType + isTile + valueString;
            valueMap[valueKey] = key;
        }
    }


    for (const key of Object.keys(previousParsed)) {
        if (key === "*") continue;

        const current = previousParsed[key];

        let valueString: string;
        let displayName: string | undefined;
        let mimeType = defaultMime;
        let isTile = false;
        let isString = false;

        if (typeof current === "string") {
            valueString = current;
            isString = true;
        }
        else {
            valueString = current.data;
            displayName = current.displayName;
            mimeType = current.mimeType;
            isTile = !!current.tilemapTile;
        }

        // Skip duplicate images, tiles, and animations
        const valueKey = mimeType + isTile + valueString;
        if (valueMap[valueKey])  {
            if (isTile) tileMapping[pxt.sprite.TILE_NAMESPACE + "." + key] = pxt.sprite.TILE_NAMESPACE + "." + valueMap[valueKey];
            continue;
        }

        if (!displayName) {
            // The assets will disappear if they don't have a display name because they are
            // not referenced anywhere in the blocks project. We need to generate new names
            // for them to prevent that from happening

            switch (mimeType) {
                case pxt.IMAGE_MIME_TYPE:
                    displayName = isTile ? `${pxt.sprite.TILE_NAMESPACE}.${pxt.sprite.TILE_PREFIX}` :
                        `${pxt.sprite.IMAGES_NAMESPACE}.${pxt.sprite.IMAGE_PREFIX}` ;
                    break;
                case pxt.TILEMAP_MIME_TYPE:
                    displayName = "tilemap";
                    break;
                case pxt.ANIMATION_MIME_TYPE:
                    displayName = `${pxt.sprite.ANIMATION_NAMESPACE}.${pxt.sprite.ANIMATION_PREFIX}` ;
                    break;

            }
        }

        // Display names need to be unique
        if (displayName && nameMap[displayName]) {
            let index = 0;
            while (nameMap[displayName + index]) {
                index++;
            }
            displayName = displayName + index;
            nameMap[displayName] = true;
        }

        // Ids also need to be unique
        let id = key;
        if (idMap[id]) {
            let index = 0;
            while (idMap[id + index]) {
                index++;
            }
            id = id + index;
            idMap[id] = true;
            if (isTile) tileMapping[pxt.sprite.TILE_NAMESPACE + "." + key] = pxt.sprite.TILE_NAMESPACE + "." + id;
        }

        if (mimeType !== pxt.TILEMAP_MIME_TYPE) {
            valueMap[valueKey] = key;
        }

        const entry = {
            ...(isString ? {} : previousParsed[key] as pxt.JRes),
            data: valueString,
            displayName,
            mimeType
        } as any;

        // Only tilemap entries specify an id, other mimes just use the namespace + key
        if (entry.id) entry.id = id;

        if (mimeType === pxt.TILEMAP_MIME_TYPE) {
            tilemapEntries[id] = entry
        }
        else {
            nextParsed[id] = entry
        }
    }

    // If any tiles changed ids, we need to fix the tilemaps' tilesets to point to the new ids
    for (const key of Object.keys(tilemapEntries)) {
        const entry = tilemapEntries[key];
        entry.tileset = entry.tileset?.map(id => tileMapping[id] || id);
        nextParsed[key] = entry;
    }

    return JSON.stringify(nextParsed);
}