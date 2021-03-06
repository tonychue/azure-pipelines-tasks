import tl = require("vsts-task-lib/task");
import path = require("path");
import fs = require('fs');
import { WebResponse } from "./webClient";
import { Release } from "./Release";
import { Utility, Inputs, AssetUploadMode, GitHubAttributes } from "./Utility";
import { Helper } from "./Helper";

export class Action {

    /**
     * Creating a release and uploading assets are 2 different process. First we create a release and when it is successful, we upload assets to it.
     * But in our scenario, we assume it to be a single process, means if upload assets step fail then we say release is in dirty state and we would want it to be deleted as it is without assets yet.
     * So, we delete the created release as assets are not uploaded to it. And will want user to run the task again to create release with assets.
     * The delete release step is only reachable if user has specified any assets to upload and the upload step failed.
     * @param githubEndpointToken 
     * @param repositoryName 
     * @param target 
     * @param tag 
     * @param releaseTitle 
     * @param releaseNote 
     * @param isDraft 
     * @param isPrerelease 
     * @param githubReleaseAssetInputPatterns 
     */
    public static async createReleaseAction(githubEndpointToken: string, repositoryName: string, target: string, tag: string, releaseTitle: string, releaseNote: string, isDraft: boolean, isPrerelease: boolean, githubReleaseAssetInputPatterns: string[]): Promise<void> {
        console.log(tl.loc("CreatingRelease", tag));

        // Create release
        let response: WebResponse = await Release.createRelease(githubEndpointToken, repositoryName, target, tag, releaseTitle, releaseNote, isDraft, isPrerelease);
        tl.debug("Create release response: " + JSON.stringify(response));

        if (response.statusCode === 201) {
            try {
                // Upload the assets
                const uploadUrl: string = response.body[GitHubAttributes.uploadUrl];
                await this._uploadAssets(githubEndpointToken, repositoryName, githubReleaseAssetInputPatterns, uploadUrl, []);
                console.log(tl.loc("CreateReleaseSuccess", response.body[GitHubAttributes.htmlUrl]));  
            }
            catch (error) {
                console.log(tl.loc("CreateReleaseFailed"));  

                try {
                    // If upload asets fail, then delete the release
                    let releaseId: string = response.body[GitHubAttributes.id];
                    await this._deleteRelease(githubEndpointToken, repositoryName, releaseId, tag);
                }
                catch (error) {
                    tl.debug("Failed to delete the release which is in dirty state currently. Assets were expected to be uploaded but it failed. Delete the release manually.")
                }

                throw error;
            }
        } 
        else if (response.statusCode === 422 && response.body.errors && response.body.errors.length > 0 && response.body.errors[0].code === this._alreadyExistErrorCode) {
            tl.error(tl.loc("ReleaseAlreadyExists", tag));  
            throw new Error(response.body[GitHubAttributes.message]);
        }
        else {
            tl.error(tl.loc("CreateReleaseError"));
            throw new Error(response.body[GitHubAttributes.message]);
        }
    }

    /**
     * Edits an existing release.
     * @param githubEndpointToken 
     * @param repositoryName 
     * @param target 
     * @param tag 
     * @param releaseTitle 
     * @param releaseNote 
     * @param isDraft 
     * @param isPrerelease 
     * @param githubReleaseAssetInputPatterns 
     * @param releaseId 
     */
    public static async editReleaseAction(githubEndpointToken: string, repositoryName: string, target: string, tag: string, releaseTitle: string, releaseNote: string, isDraft: boolean, isPrerelease: boolean, githubReleaseAssetInputPatterns: string[], releaseId: string): Promise<void> {
        console.log(tl.loc("EditingRelease", tag));

        let response: WebResponse = await Release.editRelease(githubEndpointToken, repositoryName, target, tag, releaseTitle, releaseNote, isDraft, isPrerelease, releaseId);
        tl.debug("Edit release response: " + JSON.stringify(response));

        if (response.statusCode === 200) {
            const uploadUrl: string = response.body[GitHubAttributes.uploadUrl];
            await this._uploadAssets(githubEndpointToken, repositoryName, githubReleaseAssetInputPatterns, uploadUrl, response.body[GitHubAttributes.assets]);
            console.log(tl.loc("EditReleaseSuccess", response.body[GitHubAttributes.htmlUrl]));
        }
        else {
            tl.error(tl.loc("EditReleaseError"));
            throw new Error(response.body[GitHubAttributes.message]);
        }  
    }

    /**
     * Deletes a release if it exists.
     * @param githubEndpointToken 
     * @param repositoryName 
     * @param tag 
     */
    public static async deleteReleaseAction(githubEndpointToken: string, repositoryName: string, tag: string): Promise<void> {
        // Get the release id of the release with corresponding tag to delete.
        console.log(tl.loc("FetchReleaseForTag", tag));
        let releaseId: string = await Helper.getReleaseIdForTag(githubEndpointToken, repositoryName, tag);

        if (!!releaseId) {
            console.log(tl.loc("FetchReleaseForTagSuccess", tag));
            await this._deleteRelease(githubEndpointToken, repositoryName, releaseId, tag);
        }
        else {
            throw new Error(tl.loc("NoReleaseFoundToDelete", tag));
        }
    }

    /**
     * Deletes an existing release.
     * @param githubEndpointToken 
     * @param repositoryName 
     * @param releaseId 
     * @param tag 
     */
    private static async _deleteRelease(githubEndpointToken: string, repositoryName: string, releaseId: string, tag: string): Promise<void> {
        console.log(tl.loc("DeletingRelease", tag));
        let response: WebResponse = await Release.deleteRelease(githubEndpointToken, repositoryName, releaseId);
        tl.debug("Delete release response: " + JSON.stringify(response));

        if (response.statusCode === 204) {
            console.log(tl.loc("DeleteReleaseSuccess"));
        }
        else {
            tl.error(tl.loc("DeleteReleaseError"));
            throw new Error(response.body[GitHubAttributes.message]);
        }
    }

    /**
     * Upload assets to the release.
     * @param githubEndpointToken 
     * @param repositoryName 
     * @param githubReleaseAssetInputPatterns 
     * @param uploadUrl 
     * @param existingAssets 
     */
    private static async _uploadAssets(githubEndpointToken: string, repositoryName: string, githubReleaseAssetInputPatterns: string[], uploadUrl: string, existingAssets: any[]): Promise<void> {
        const assetUploadMode = tl.getInput(Inputs.assetUploadMode);
        let assets: string[] = Utility.getUploadAssets(githubReleaseAssetInputPatterns) || [];

        Utility.validateUploadAssets(assets);

        // Delete all assets
        if (!!assetUploadMode && assetUploadMode === AssetUploadMode.delete) {
            console.log(tl.loc("DeleteAllExistingAssets"));
            await this._deleteAssets(githubEndpointToken, repositoryName, existingAssets);
        }

        if (assets && assets.length > 0) {
            console.log(tl.loc("UploadingAssets"));
        }
        else {
            console.log(tl.loc("NoAssetFoundToUpload"));
            return;
        }

        for (let index = 0; index < assets.length; index++) {
            const asset = assets[index];
            console.log(tl.loc("UploadingAsset", asset));

            if (fs.lstatSync(path.resolve(asset)).isDirectory()) {
                tl.warning(tl.loc("AssetIsDirectoryError", asset));
                continue;
            }

            let uploadResponse = await Release.uploadReleaseAsset(githubEndpointToken, asset, uploadUrl);
            tl.debug("Upload asset response: " + JSON.stringify(uploadResponse));
            
            if (uploadResponse.statusCode === 201) {
                console.log(tl.loc("UploadAssetSuccess", asset));
            }
            else if (uploadResponse.statusCode === 422 && uploadResponse.body.errors && uploadResponse.body.errors.length > 0 && uploadResponse.body.errors[0].code === this._alreadyExistErrorCode) {
                
                if (assetUploadMode === AssetUploadMode.replace) {
                    console.log(tl.loc("DuplicateAssetFound", asset));
                    console.log(tl.loc("DeletingDuplicateAsset", asset));

                    const fileName = path.basename(asset);

                    for (let existingAsset of existingAssets) {
                        if (fileName === existingAsset.name) {
                            await this._deleteAssets(githubEndpointToken, repositoryName, [existingAsset]);
                            index--;
                            break;
                        }
                    }
                }
                else {
                    tl.warning(tl.loc("SkipDuplicateAssetFound", asset));
                }
            }
            else {
                tl.error(tl.loc("UploadAssetError"))
                throw new Error(uploadResponse.body[GitHubAttributes.message]);
            }
        }
        console.log(tl.loc("AllAssetsUploadedSuccessfully"));
    }

    /**
     * Delete assets.
     * @param githubEndpointToken 
     * @param repositoryName 
     * @param assets 
     */
    private static async _deleteAssets(githubEndpointToken: string, repositoryName: string, assets: any[]): Promise<void> {
        if (assets && assets.length ===  0) {
            console.log(tl.loc("NoAssetFoundToDelete"));
            return;
        }

        for (let asset of assets) {
            console.log(tl.loc("DeletingAsset", asset));
            let deleteAssetResponse = await Release.deleteReleaseAsset(githubEndpointToken, repositoryName, asset.id);
            tl.debug("Delete asset response: " + JSON.stringify(deleteAssetResponse));

            if (deleteAssetResponse.statusCode === 204) {
                console.log(tl.loc("AssetDeletedSuccessfully", asset));
            }
            else {
                tl.error(tl.loc("ErrorDeletingAsset", asset));
                throw new Error(deleteAssetResponse.body[GitHubAttributes.message]);
            }
        }
        console.log(tl.loc("AssetsDeletedSuccessfully"));
    }

    private static readonly _alreadyExistErrorCode: string = "already_exists";
}