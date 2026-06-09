/**
 * @file videos.ts
 * @description 即梦视频生成路由，支持 /v1/videos/generations 接口，提供同步或 BASE64 格式的视频生成，并完美支持全能(omni_reference)与普通模式的多账号池化。
 */

import _ from 'lodash';
import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import FailureBody from '@/lib/response/FailureBody.ts';
import AccountManager from '@/lib/account-manager.ts';
import APIException from '@/lib/exceptions/APIException.ts';
import { generateVideo, DEFAULT_MODEL } from '@/jimeng/controllers/videos.ts';
import { tokenSplit } from '@/jimeng/controllers/core.ts';
import util from '@/lib/util.ts';

export default {

    prefix: '/v1/videos',

    post: {

        '/generations': async (request: Request) => {
            try {
                const contentType = request.headers['content-type'] || '';
                const isMultiPart = contentType.startsWith('multipart/form-data');

                request
                    .validate('body.model', v => _.isUndefined(v) || _.isString(v))
                    .validate('body.prompt', _.isString)
                    .validate('body.ratio', v => _.isUndefined(v) || _.isString(v))
                    .validate('body.resolution', v => _.isUndefined(v) || _.isString(v))
                    .validate('body.functionMode', v => _.isUndefined(v) || (_.isString(v) && ['first_last_frames', 'omni_reference'].includes(v)))
                    .validate('body.response_format', v => _.isUndefined(v) || _.isString(v))
                    .validate('headers.authorization', _.isString);

                const functionMode = request.body.functionMode || 'first_last_frames';
                const isOmniMode = functionMode === 'omni_reference';

                // 验证 duration（根据模型）
                if (!_.isUndefined(request.body.duration)) {
                    const modelName = request.body.model || DEFAULT_MODEL;
                    let durationValue: number;
                    if (isMultiPart && typeof request.body.duration === 'string') {
                        durationValue = parseInt(request.body.duration, 10);
                        if (!Number.isInteger(durationValue) || request.body.duration.trim() !== String(durationValue)) {
                            throw new Error(`duration 必须是整数，当前值: ${request.body.duration}`);
                        }
                    } else if (_.isFinite(request.body.duration)) {
                        durationValue = request.body.duration as number;
                        if (!Number.isInteger(durationValue)) {
                            throw new Error(`duration 必须是整数，当前值: ${durationValue}`);
                        }
                    } else {
                        throw new Error(`duration 参数格式错误`);
                    }

                    // 根据模型验证 duration 有效值
                    let validDurations: number[] = [];
                    let errorMessage = '';

                    if (modelName.includes('veo3.1') || modelName.includes('veo3')) {
                        validDurations = [8];
                        errorMessage = 'veo3 模型仅支持 8 秒时长';
                    } else if (modelName.includes('sora2')) {
                        validDurations = [4, 8, 12];
                        errorMessage = 'sora2 模型仅支持 4、8、12 秒时长';
                    } else if (modelName.includes('3.5-pro') || modelName.includes('3.5_pro')) {
                        validDurations = [5, 10, 12];
                        errorMessage = '3.5-pro 模型仅支持 5、10、12 秒时长';
                    } else if (modelName.includes('seedance-2.0') || modelName.includes('40_pro') || modelName.includes('40-pro') || modelName.includes('seedance-2.0-fast')) {
                        if (durationValue < 4 || durationValue > 15) {
                            throw new Error(`seedance 2.0/2.0-fast 模型支持 4~15 秒时长，当前值: ${durationValue}`);
                        }
                    } else {
                        validDurations = [5, 10];
                        errorMessage = '该模型仅支持 5、10 秒时长';
                    }

                    if (validDurations.length > 0 && !validDurations.includes(durationValue)) {
                        throw new Error(`${errorMessage}，当前值: ${durationValue}`);
                    }
                }

                // 验证 file_paths 和 filePaths
                request
                    .validate('body.file_paths', v => _.isUndefined(v) || (_.isArray(v) && v.length <= 2))
                    .validate('body.filePaths', v => _.isUndefined(v) || (_.isArray(v) && v.length <= 2));

                if (isOmniMode) {
                    const uploadedFiles = request.files || {};
                    let imageCount = 0;
                    let videoCount = 0;

                    for (const fieldName of Object.keys(uploadedFiles)) {
                        if (fieldName.startsWith('image_file_')) imageCount++;
                        else if (fieldName.startsWith('video_file_')) videoCount++;
                    }

                    for (let i = 1; i <= 9; i++) {
                        const fieldName = `image_file_${i}`;
                        if (typeof request.body[fieldName] === 'string' && request.body[fieldName].startsWith('http')) {
                            imageCount++;
                        }
                    }
                    for (let i = 1; i <= 3; i++) {
                        const fieldName = `video_file_${i}`;
                        if (typeof request.body[fieldName] === 'string' && request.body[fieldName].startsWith('http')) {
                            videoCount++;
                        }
                    }

                    if (imageCount > 9) {
                        throw new Error('全能模式最多上传9张图片');
                    }
                    if (videoCount > 3) {
                        throw new Error('全能模式最多上传3个视频');
                    }

                    const totalCount = imageCount + videoCount;
                    if (totalCount > 12) {
                        throw new Error('全能模式图片+视频总数不超过12个');
                    }
                    if (totalCount === 0) {
                        const hasFilePaths = (request.body.filePaths?.length > 0) || (request.body.file_paths?.length > 0);
                        if (!hasFilePaths) {
                            throw new Error('全能模式至少需要上传1个素材文件(图片或视频)');
                        }
                    }
                } else {
                    const uploadedFiles = request.files ? _.values(request.files) : [];
                    if (uploadedFiles.length > 2) {
                        throw new Error('最多只能上传2个图片文件');
                    }
                }

                const authHeader = request.headers.authorization || "";
                let account: any;
                let isPooled = false;

                if (authHeader.includes("pooled") || authHeader.length < 20) {
                    isPooled = true;
                } else {
                    const tokens = tokenSplit(authHeader);
                    account = _.sample(tokens) || "";
                    if (!account) {
                        throw new Error('无效的Authorization Token');
                    }
                }

                const {
                    model = DEFAULT_MODEL,
                    prompt,
                    ratio = "1:1",
                    resolution = "720p",
                    duration = 5,
                    file_paths = [],
                    filePaths = [],
                    response_format = "url"
                } = request.body;

                const finalDuration = isMultiPart && typeof duration === 'string'
                    ? parseInt(duration)
                    : duration;

                const finalFilePaths = filePaths.length > 0 ? filePaths : file_paths;

                let matchedAccount: any = null;
                if (!isPooled && typeof account === 'string') {
                    matchedAccount = AccountManager.getAccountByToken(account);
                    if (matchedAccount) {
                        account = matchedAccount;
                    }
                }

                if (isPooled) {
                    account = await AccountManager.acquireToken('jimeng', model);
                } else if (matchedAccount) {
                    AccountManager.lockAccount(matchedAccount, 'jimeng');
                }

                try {
                    const generatedVideoUrl = await generateVideo(
                        model,
                        prompt,
                        {
                            ratio,
                            resolution,
                            duration: finalDuration,
                            filePaths: finalFilePaths,
                            files: request.files,
                            httpRequest: request,
                            functionMode,
                        },
                        account.token
                    );

                    // 扣减视频额度（采用后扣费机制，仅在此处扣费）
                    await AccountManager.updateAccountUsage(account.id, 'video');

                    if (isPooled) AccountManager.releaseToken(account.token);
                    else if (matchedAccount) AccountManager.releaseToken(matchedAccount.token);

                    if (response_format === "b64_json") {
                        const videoBase64 = await util.fetchFileBASE64(generatedVideoUrl);
                        return {
                            created: util.unixTimestamp(),
                            data: [{
                                b64_json: videoBase64,
                                revised_prompt: prompt
                            }]
                        };
                    } else {
                        return {
                            created: util.unixTimestamp(),
                            data: [{
                                url: generatedVideoUrl,
                                revised_prompt: prompt
                            }]
                        };
                    }
                } catch (generationError) {
                    if (isPooled && account) AccountManager.releaseToken(account.token);
                    else if (matchedAccount) AccountManager.releaseToken(matchedAccount.token);
                    throw generationError;
                }
            } catch (err: any) {
                if (err instanceof APIException) {
                    return new Response(new FailureBody(err), { statusCode: err.httpStatusCode });
                }
                throw err;
            }
        }

    }

}
