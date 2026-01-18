import type { GetAuth, PluginClient, Provider } from "./types";

let currentGetAuth: GetAuth | undefined;
let currentProvider: Provider | undefined;
let currentClient: PluginClient | undefined;

export const setGlobalState = (getAuth: GetAuth, provider: Provider, client: PluginClient) => {
  currentGetAuth = getAuth;
  currentProvider = provider;
  currentClient = client;
};

export const getGlobalState = () => ({
  getAuth: currentGetAuth,
  provider: currentProvider,
  client: currentClient,
});
