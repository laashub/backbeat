const joi = require('@hapi/joi');

const joiSchema = {
    auth: joi.object({
        type: joi.string().valid('service').required(),
        account: joi.string().required(),
    }).required(),
    topic: joi.string().required(),
    zookeeperPath: joi.string().required(),
    cronRule: joi.string().default('*/5 * * * * *'),
    maxParallelReaders: joi.number().greater(0).default(5),
    sources: joi.array().required(),
};

function configValidator(backbeatConfig, extConfig) {
    const validatedConfig = joi.attempt(extConfig, joiSchema);
    return validatedConfig;
}

module.exports = configValidator;
