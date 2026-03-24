import { errorHandling, telemetryData } from "./utils/middleware.js";

const MAX_BATCH_SIZE = 10;
const MAX_RETRIES = 2;

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const clonedRequest = request.clone();
        const formData = await clonedRequest.formData();

        await errorHandling(context);
        telemetryData(context);

        const uploadFiles = collectUploadFiles(formData);
        validateUploadFiles(uploadFiles);

        const results = await uploadFilesBatch(uploadFiles, env);

        return new Response(
            JSON.stringify(results),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    } catch (error) {
        console.error('Upload error:', error);

        const status = error && error.statusCode ? error.statusCode : 500;

        return new Response(
            JSON.stringify({ error: error.message }),
            {
                status,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

export function collectUploadFiles(formData) {
    const files = formData.getAll('file').filter(Boolean);

    // 兼容旧前端字段名，避免单文件上传被新后端打断。
    if (files.length > 0) {
        return files;
    }

    const legacyFile = formData.get('file');
    return legacyFile ? [legacyFile] : [];
}

export function validateUploadFiles(files) {
    if (!Array.isArray(files) || files.length === 0) {
        throw createBadRequest('No file uploaded');
    }

    if (files.length > MAX_BATCH_SIZE) {
        throw createBadRequest(`Too many files uploaded, max ${MAX_BATCH_SIZE}`);
    }
}

export function shouldUseMediaGroup(files) {
    if (!Array.isArray(files) || files.length < 2 || files.length > MAX_BATCH_SIZE) {
        return false;
    }

    return files.every((file) => {
        const mimeType = file && file.type ? file.type : '';
        return mimeType.startsWith('image/') || mimeType.startsWith('video/');
    });
}

export function formatUploadResult(fileId, fileName, mimeType = '') {
    const fileExtension = getFileExtension(fileName);

    return {
        src: `/file/${fileId}.${fileExtension}`,
        fileName,
        mimeType,
    };
}

export function extractMediaGroupResults(response, files) {
    if (!response || !response.ok || !Array.isArray(response.result)) {
        return [];
    }

    return response.result.map((message, index) => {
        const uploadFile = files[index];
        const fileId = getFileId({ ok: true, result: message });

        if (!fileId) {
            throw new Error('Failed to get file ID');
        }

        return formatUploadResult(fileId, uploadFile.name, uploadFile.type);
    });
}

export async function uploadFilesBatch(files, env) {
    if (shouldUseMediaGroup(files)) {
        try {
            return await uploadMediaGroup(files, env);
        } catch (error) {
            console.warn('Media group upload failed, falling back to single uploads.', error);
        }
    }

    const results = [];

    for (const uploadFile of files) {
        results.push(await uploadSingleFile(uploadFile, env));
    }

    return results;
}

export async function uploadMediaGroup(files, env) {
    const telegramFormData = new FormData();
    const media = [];

    telegramFormData.append("chat_id", env.TG_Chat_ID);

    files.forEach((uploadFile, index) => {
        const attachmentName = `file${index}`;
        const mediaType = uploadFile.type.startsWith('video/') ? 'video' : 'photo';

        telegramFormData.append(attachmentName, uploadFile, uploadFile.name);
        media.push({
            type: mediaType,
            media: `attach://${attachmentName}`
        });
    });

    telegramFormData.append('media', JSON.stringify(media));

    const result = await sendToTelegram(telegramFormData, 'sendMediaGroup', env);

    if (!result.success) {
        throw new Error(result.error);
    }

    const formattedResults = extractMediaGroupResults(result.data, files);

    await saveUploadRecords(files, formattedResults, env);

    return formattedResults;
}

export async function uploadSingleFile(uploadFile, env) {
    const telegramFormData = new FormData();
    const apiEndpoint = getSingleFileEndpoint(uploadFile);

    telegramFormData.append("chat_id", env.TG_Chat_ID);

    if (apiEndpoint === 'sendPhoto') {
        telegramFormData.append("photo", uploadFile);
    } else if (apiEndpoint === 'sendAudio') {
        telegramFormData.append("audio", uploadFile);
    } else if (apiEndpoint === 'sendVideo') {
        telegramFormData.append("video", uploadFile);
    } else {
        telegramFormData.append("document", uploadFile);
    }

    const result = await sendToTelegram(telegramFormData, apiEndpoint, env);

    if (!result.success) {
        throw new Error(result.error);
    }

    const fileId = getFileId(result.data);

    if (!fileId) {
        throw new Error('Failed to get file ID');
    }

    const formattedResult = formatUploadResult(fileId, uploadFile.name, uploadFile.type);

    await saveUploadRecord(uploadFile, formattedResult, env);

    return formattedResult;
}

export function getSingleFileEndpoint(uploadFile) {
    if (uploadFile.type.startsWith('image/')) {
        return 'sendPhoto';
    }

    if (uploadFile.type.startsWith('audio/')) {
        return 'sendAudio';
    }

    if (uploadFile.type.startsWith('video/')) {
        return 'sendVideo';
    }

    return 'sendDocument';
}

export function getFileId(response) {
    if (!response.ok || !response.result) return null;

    const result = response.result;
    if (result.photo) {
        return result.photo.reduce((prev, current) =>
            (prev.file_size > current.file_size) ? prev : current
        ).file_id;
    }
    if (result.document) return result.document.file_id;
    if (result.video) return result.video.file_id;
    if (result.audio) return result.audio.file_id;

    return null;
}

export async function sendToTelegram(formData, apiEndpoint, env, retryCount = 0) {
    const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/${apiEndpoint}`;

    try {
        const response = await fetch(apiUrl, { method: "POST", body: formData });
        const responseData = await response.json();

        if (response.ok) {
            return { success: true, data: responseData };
        }

        // 图片上传失败时转为文档方式重试，尽量提高兼容性。
        if (retryCount < MAX_RETRIES && apiEndpoint === 'sendPhoto') {
            console.log('Retrying image as document...');
            const newFormData = new FormData();
            newFormData.append('chat_id', formData.get('chat_id'));
            newFormData.append('document', formData.get('photo'));
            return await sendToTelegram(newFormData, 'sendDocument', env, retryCount + 1);
        }

        return {
            success: false,
            error: responseData.description || 'Upload to Telegram failed'
        };
    } catch (error) {
        console.error('Network error:', error);
        if (retryCount < MAX_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
            return await sendToTelegram(formData, apiEndpoint, env, retryCount + 1);
        }
        return { success: false, error: 'Network error occurred' };
    }
}

export async function saveUploadRecords(files, results, env) {
    for (let index = 0; index < files.length; index += 1) {
        await saveUploadRecord(files[index], results[index], env);
    }
}

export async function saveUploadRecord(uploadFile, formattedResult, env) {
    if (!env.img_url || !formattedResult || !formattedResult.src) {
        return;
    }

    const fileId = pathFromSrc(formattedResult.src);
    const fileExtension = getFileExtension(uploadFile.name);

    await env.img_url.put(`${fileId}.${fileExtension}`, "", {
        metadata: {
            TimeStamp: Date.now(),
            ListType: "None",
            Label: "None",
            liked: false,
            fileName: uploadFile.name,
            fileSize: uploadFile.size,
        }
    });
}

function getFileExtension(fileName = '') {
    const extension = String(fileName).split('.').pop();
    return extension ? extension.toLowerCase() : 'bin';
}

function pathFromSrc(src = '') {
    return src.replace(/^\/file\//, '').replace(/\.[^.]+$/, '');
}

function createBadRequest(message) {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
}
