// Standalone Mode: Cloud sync is disabled. Running on pure local SQLite.
module.exports = {
  isCloudConfigured: () => false,
  getCloudClient: () => null,
  initCloudDatabase: async () => ({ cloud: false }),
  syncAllLocalToCloud: async () => {},
  executeCloudSql: () => {}
};
