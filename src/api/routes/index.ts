import fs from 'fs-extra';

import Response from '@/lib/response/Response.ts';
import chat from "./chat.ts";
import images from "./images.ts"
import video from "./video.ts";
import music from "./music.ts";
import media from "./media.ts";
import ping from "./ping.ts";
import token from './token.js';
import models from './models.ts';
import admin from './admin.ts';

export default [
    {
        get: {
            '/': async () => {
                const content = await fs.readFile('public/welcome.html');
                return new Response(content, {
                    type: 'html',
                    headers: {
                        Expires: '-1'
                    }
                });
            }
        }
    },
    chat,
    images,
    video,
    music,
    media,
    ping,
    token,
    models,
    admin
];
