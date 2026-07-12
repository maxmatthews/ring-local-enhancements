module.exports = {
	apps: [
		{
			name: "ring-local-enhancements",
			script: "./index.mjs",
			cwd: "/home/pi/ring-local-enhancements",
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
