const {
  ErrorTypes,
  EModelEndpoint,
  resolveHeaders,
  mapModelToAzureConfig,
} = require('librechat-data-provider');
const { getUserKeyValues, checkUserKeyExpiry } = require('~/server/services/UserService');
const { getLLMConfig } = require('~/server/services/Endpoints/openAI/llm');
const { isEnabled, isUserProvided, sleep } = require('~/server/utils');
const { getAzureCredentials } = require('~/utils');
const { OpenAIClient } = require('~/app');

const initializeClient = async ({
  req,
  res,
  endpointOption,
  optionsOnly,
  overrideEndpoint,
  overrideModel,
}) => {
  const {
    PROXY,
    OPENAI_API_KEY,
    AZURE_API_KEY,
    OPENAI_REVERSE_PROXY,
    AZURE_OPENAI_BASEURL,
    OPENAI_SUMMARIZE,
    DEBUG_OPENAI,
    OPENROUTER_KEY,
  } = process.env;
  const { key: expiresAt } = req.body;
  const modelName = overrideModel ?? req.body.model;
  
  // Set openAI endpoint as default but override with OpenRouter when needed
  const endpoint = overrideEndpoint ?? req.body.endpoint ?? EModelEndpoint.openAI;
  const contextStrategy = isEnabled(OPENAI_SUMMARIZE) ? 'summarize' : null;

  const credentials = {
    [EModelEndpoint.openAI]: OPENAI_API_KEY,
    [EModelEndpoint.azureOpenAI]: AZURE_API_KEY,
  };

  const baseURLOptions = {
    [EModelEndpoint.openAI]: OPENAI_REVERSE_PROXY,
    [EModelEndpoint.azureOpenAI]: AZURE_OPENAI_BASEURL,
  };

  // Setting the user provides key to false as we're using OpenRouter
  const userProvidesKey = false; // Disabling user provided API keys
  const userProvidesURL = false; // Disabling user provided URLs

  // No need to check user values since we're using OpenRouter
  let userValues = null;

  // Always use OpenRouter for OpenAI endpoint
  let apiKey = OPENROUTER_KEY;
  // Set OpenRouter as the base URL
  let baseURL = 'https://openrouter.ai/api/v1';

  let clientOptions = {
    contextStrategy,
    proxy: PROXY ?? null,
    debug: isEnabled(DEBUG_OPENAI),
    reverseProxyUrl: baseURL ? baseURL : null,
    ...endpointOption,
  };

  const isAzureOpenAI = endpoint === EModelEndpoint.azureOpenAI;
  /** @type {false | TAzureConfig} */
  const azureConfig = isAzureOpenAI && req.app.locals[EModelEndpoint.azureOpenAI];

  if (isAzureOpenAI && azureConfig) {
    const { modelGroupMap, groupMap } = azureConfig;
    const {
      azureOptions,
      baseURL,
      headers = {},
      serverless,
    } = mapModelToAzureConfig({
      modelName,
      modelGroupMap,
      groupMap,
    });

    clientOptions.reverseProxyUrl = baseURL ?? clientOptions.reverseProxyUrl;
    clientOptions.headers = resolveHeaders({ ...headers, ...(clientOptions.headers ?? {}) });

    clientOptions.titleConvo = azureConfig.titleConvo;
    clientOptions.titleModel = azureConfig.titleModel;

    const azureRate = modelName.includes('gpt-4') ? 30 : 17;
    clientOptions.streamRate = azureConfig.streamRate ?? azureRate;

    clientOptions.titleMethod = azureConfig.titleMethod ?? 'completion';

    const groupName = modelGroupMap[modelName].group;
    clientOptions.addParams = azureConfig.groupMap[groupName].addParams;
    clientOptions.dropParams = azureConfig.groupMap[groupName].dropParams;
    clientOptions.forcePrompt = azureConfig.groupMap[groupName].forcePrompt;

    apiKey = azureOptions.azureOpenAIApiKey;
    clientOptions.azure = !serverless && azureOptions;
    if (serverless === true) {
      clientOptions.defaultQuery = azureOptions.azureOpenAIApiVersion
        ? { 'api-version': azureOptions.azureOpenAIApiVersion }
        : undefined;
      clientOptions.headers['api-key'] = apiKey;
    }
  } else if (isAzureOpenAI) {
    clientOptions.azure = userProvidesKey ? JSON.parse(userValues.apiKey) : getAzureCredentials();
    apiKey = clientOptions.azure.azureOpenAIApiKey;
  }

  /** @type {undefined | TBaseEndpoint} */
  const openAIConfig = req.app.locals[EModelEndpoint.openAI];

  if (!isAzureOpenAI && openAIConfig) {
    clientOptions.streamRate = openAIConfig.streamRate;
    clientOptions.titleModel = openAIConfig.titleModel;
  }

  /** @type {undefined | TBaseEndpoint} */
  const allConfig = req.app.locals.all;
  if (allConfig) {
    clientOptions.streamRate = allConfig.streamRate;
  }

  if (userProvidesKey & !apiKey) {
    throw new Error(
      JSON.stringify({
        type: ErrorTypes.NO_USER_KEY,
      }),
    );
  }

  if (!apiKey) {
    throw new Error(`${endpoint} API Key not provided.`);
  }

  if (optionsOnly) {
    const modelOptions = endpointOption.model_parameters;
    modelOptions.model = modelName;
    clientOptions = Object.assign({ modelOptions }, clientOptions);
    clientOptions.modelOptions.user = req.user.id;
    const options = getLLMConfig(apiKey, clientOptions);
    if (!clientOptions.streamRate) {
      return options;
    }
    options.llmConfig.callbacks = [
      {
        handleLLMNewToken: async () => {
          await sleep(clientOptions.streamRate);
        },
      },
    ];
    return options;
  }

  const client = new OpenAIClient(apiKey, Object.assign({ req, res }, clientOptions));
  return {
    client,
    openAIApiKey: apiKey,
  };
};

module.exports = initializeClient;
