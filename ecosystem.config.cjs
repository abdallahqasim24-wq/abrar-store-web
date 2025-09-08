
module.exports = {
  apps: [{
    name: 'abrar-store',
    script: 'server.js',
    instances: 1,
    watch: false,
    env: { NODE_ENV: 'production', PORT: 3000 }
  }]
}
