web: node --max-old-space-size=384 --heapsnapshot-signal=SIGUSR2 dist/src/server.js
agent: node --max-old-space-size=384 --heapsnapshot-signal=SIGUSR2 dist/src/plutoAgent.js
release: npm run migrate:latest:prod && npm run release-phase:worker-deploy
