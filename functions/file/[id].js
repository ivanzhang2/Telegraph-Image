export async function onRequest(context) {
    const { request, env, params } = context

    const url = new URL(request.url)
    let fileUrl = 'https://telegra.ph/' + url.pathname + url.search
    if (url.pathname.length > 39) {
        const fileId = url.pathname.split('.')[0].split('/')[2]
        const filePath = await getFilePath(env, fileId)
        fileUrl = `https://api.telegram.org/file/bot${env.TG_Bot_Token}/${filePath}`
    }

    const response = await fetch(fileUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
    })

    if (!response.ok) return response

    const normalizedResponse = await normalizeResponse(response, url.pathname)

    const isAdmin = request.headers.get('Referer')?.includes(`${url.origin}/admin`)
    if (isAdmin) {
        return normalizedResponse
    }

    if (!env.img_url) {
        return normalizedResponse
    }

    let record = await env.img_url.getWithMetadata(params.id)
    if (!record || !record.metadata) {
        record = {
            metadata: {
                ListType: 'None',
                Label: 'None',
                TimeStamp: Date.now(),
                liked: false,
                fileName: params.id,
                fileSize: 0,
            },
        }
        await env.img_url.put(params.id, '', { metadata: record.metadata })
    }

    const metadata = {
        ListType: record.metadata.ListType || 'None',
        Label: record.metadata.Label || 'None',
        TimeStamp: record.metadata.TimeStamp || Date.now(),
        liked: record.metadata.liked !== undefined ? record.metadata.liked : false,
        fileName: record.metadata.fileName || params.id,
        fileSize: record.metadata.fileSize || 0,
    }

    if (metadata.ListType === 'White') {
        return normalizedResponse
    } else if (metadata.ListType === 'Block' || metadata.Label === 'adult') {
        const referer = request.headers.get('Referer')
        const redirectUrl = referer
            ? 'https://static-res.pages.dev/teleimage/img-block-compressed.png'
            : `${url.origin}/block-img.html`
        return Response.redirect(redirectUrl, 302)
    }

    if (env.WhiteList_Mode === 'true') {
        return Response.redirect(`${url.origin}/whitelist-on.html`, 302)
    }

    if (env.ModerateContentApiKey) {
        try {
            const moderateUrl = `https://api.moderatecontent.com/moderate/?key=${env.ModerateContentApiKey}&url=https://telegra.ph${url.pathname}${url.search}`
            const moderateResponse = await fetch(moderateUrl)

            if (moderateResponse.ok) {
                const moderateData = await moderateResponse.json()

                if (moderateData && moderateData.rating_label) {
                    metadata.Label = moderateData.rating_label

                    if (moderateData.rating_label === 'adult') {
                        await env.img_url.put(params.id, '', { metadata })
                        return Response.redirect(`${url.origin}/block-img.html`, 302)
                    }
                }
            }
        } catch (error) {
            console.error('Content moderation failed:', error.message)
        }
    }

    await env.img_url.put(params.id, '', { metadata })
    return normalizedResponse
}

async function normalizeResponse(response, pathname) {
    const headers = new Headers(response.headers)
    headers.set('cache-control', 'public, max-age=31536000, immutable')
    headers.delete('content-disposition')

    // if (!headers.has('content-type'))
    {
        headers.set('content-type', guessMimeType(pathname))
    }

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    })
}

function guessMimeType(pathname) {
    const ext = String(pathname).split('.').pop().toLowerCase()
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
    if (ext === 'png') return 'image/png'
    if (ext === 'gif') return 'image/gif'
    if (ext === 'webp') return 'image/webp'
    if (ext === 'mp4') return 'video/mp4'
    return 'application/octet-stream'
}

async function getFilePath(env, file_id) {
    try {
        const url = `https://api.telegram.org/bot${env.TG_Bot_Token}/getFile?file_id=${file_id}`
        const res = await fetch(url, { method: 'GET' })

        if (!res.ok) {
            console.error(`getFile error status: ${res.status}`)
            return null
        }

        const responseData = await res.json()
        if (responseData?.ok && responseData.result) {
            return responseData.result.file_path
        }

        console.error('getFile response invalid', responseData)
        return null
    } catch (error) {
        console.error('Error fetching file path:', error.message)
        return null
    }
}
