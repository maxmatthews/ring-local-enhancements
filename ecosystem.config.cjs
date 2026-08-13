module.exports = {
	apps: [
		{
			name: "ring-local-enhancements",
			script: "./index.mjs",
			cwd: "/home/pi/ring-local-enhancements",
			// Relative on purpose. pm2 otherwise records whatever absolute
			// node path it resolved at start time into ~/.pm2/dump.pm2, which
			// goes stale on the next nvm upgrade and pins the app to a Node
			// version that may later be removed.
			interpreter: "node",
			instances: 1,
			autorestart: true,
			watch: false,
			max_memory_restart: "500M",
			env: {
				NODE_ENV: "production",
			},
		},
	],
};
