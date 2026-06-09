import _ from 'lodash';
import AccountManager from '@/lib/account-manager.ts';
import JimengModelManager from '@/lib/jimeng-model-manager.ts';

export default {

    prefix: '/v1',

    get: {
        '/models': async () => {
            const models = AccountManager.getAvailableModels();
            const jimengModels = JimengModelManager.getEnabledModels().map(m => ({
                id: m.id,
                object: m.object,
                owned_by: "jimeng-api"
            }));
            return {
                "data": models.concat(jimengModels)
            };
        }

    }
}