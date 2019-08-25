const logRoot = require('log'),
	log = logRoot('proxy')

if(['11.0.0', '11.1.0', '11.2.0', '11.3.0'].includes(process.versions.node)) {
	log.error(`Node.JS ${process.versions.node} contains a critical bug preventing timers from working.
Please install a newer version or revert to 10.14.1 LTS.`)
	return
}
if(typeof BigInt === 'undefined' || require('module').createRequireFromPath === undefined) {
	log.error(`Your version of Node.JS is outdated.
Please install the latest Current from https://nodejs.org/`)
	return
}
if(process.platform !== 'win32') {
	log.error('TERA Proxy only supports Windows.')
	return
}

const net = require('net'),
	path = require('path'),
	settings = require('../../settings/_tera-proxy_.json')

;(async () => {
	log.info(`Node version: ${process.versions.node}`)

	try {
		await new Promise((resolve, reject) => {
			net.createServer().listen('\\\\.\\pipe\\tera-proxy', resolve).on('error', reject)
		})
	}
	catch(e) {
		log.error('Another instance of TERA Proxy is already running. Please close it then try again.')
		return
	}

	if(settings.devWarnings) logRoot.level = 'dwarn'

	if(settings.autoUpdate) {
		log.info('Checking for updates')

		try {
			const branch = settings.branch || 'master'

			if(await (new (require('updater'))).update({
				dir: path.join(__dirname, '../..'),
				manifestUrl: `https://raw.githubusercontent.com/tera-proxy/tera-proxy/${branch}/manifest.json`,
				defaultUrl: `https://raw.githubusercontent.com/tera-proxy/tera-proxy/${branch}/`,
			})) {
				log.info('TERA Proxy has been updated. Please restart it to apply changes.')
				return
			}
			log.info('Proxy is up to date')
		}
		catch(e) {
			log.error('Error checking for updates:')
			if(e.request) log.error(e.message)
			else log.error(e)
		}
	}

	const ProxyGame = require('proxy-game'),
		{ ModManager, Dispatch, Connection, RealClient } = require('tera-proxy-game'),
		servers = require('./servers')

	let initialized = false

	const modManager = new ModManager({
		modsDir: path.join(__dirname, '..', '..', 'mods'),
		settingsDir: path.join(__dirname, '..', '..', 'settings'),
		// Disable at your own risk!
		blacklist(pkg) {
			const name = pkg.name

			if(['CaaliLogger', 'CaaliStateTracker'].includes(name)) return 'Data collector'

			// Note: This one is specifically blacklisted because the auto-update redirect will throw confusing errors otherwise
			if(name === 'flasher') return 'Incompatible'

			if([
				'anti-cc',
				'auto-fishing',
				'auto-heal',
				'auto retaliate',
				'battleground-capper',
				'berserker-unleash',
				'corsair-memes',
				'easy-fishing',
				'fast-runeburst',
				'fast solo dungeons',
				'faster-petrax',
				'instant-revive',
				'kumas-royale-ru-tera',
				'let-me-fish',
				'let-me-target',
				'op-zerker-unleash',
				'parcel-memes',
				'rtport'
			].includes(name.toLowerCase()))
				return 'High risk of ban'

			if(name === 'Auto Target' && pkg.author === 'Fukki')
				return 'Possible malware/riskware'
		},
		autoUpdate: settings.autoUpdateMods
	})

	await modManager.init()

	const redirects = [],
		serverQ = []

	for(let data of servers) {
		let redirect

		const server = net.createServer(socket => {
			if(!initialized) { // Should never happen, but would result in an infinite loop otherwise
				socket.end()
				return
			}

			const logThis = log(`client ${socket.remoteAddress}:${socket.remotePort}`)

			socket.setNoDelay(true)

			const dispatch = new Dispatch(modManager),
				connection = new Connection(dispatch, { classic: data.type === 'classic' }),
				client = new RealClient(connection, socket),
				srvConn = connection.connect(client, { host: redirect[2], port: redirect[3] }) // Connect to self to bypass redirection

			logThis.log('connecting')

			dispatch.once('init', () => {
				dispatch.region = data.region
				dispatch.loadAll()
			})

			socket.on('error', err => {
				if(err.code === 'ECONNRESET') logThis.log('lost connection to client')
				else logThis.warn(err)
			})

			srvConn.on('connect', () => { logThis.log(`connected to ${srvConn.remoteAddress}:${srvConn.remotePort}`) })

			srvConn.on('error', err => {
				if(err.code === 'ECONNRESET') logThis.log('lost connection to server')
				else if(err.code === 'ETIMEDOUT') logThis.log('timed out waiting for server response')
				else logThis.warn(err)
			})

			srvConn.on('close', () => { logThis.log('disconnected') })
		})

		serverQ.push(new Promise((resolve, reject) => {
			server.listen(0, '127.0.0.2', resolve).on('error', reject)
		}).then(() => {
			const addr = server.address()
			redirects.push(redirect = [data.ip, data.port, addr.address, addr.port])
		}))
	}

	await Promise.all(serverQ)

	try {
		// Swap gameserver addresses with proxy ones
		const pg = new ProxyGame(`tcp && (${
			['127.0.0.2', ...new Set(servers.map(s => s.ip))].map(ip => `ip.SrcAddr == ${ip}||ip.DstAddr==${ip}`).join('||')
		})`, ...redirects)

		setInterval(() => { pg }, 60000) // TODO: Store object in C++ memory and only delete on close()
	}
	catch(e) {
		let msg = null

		switch(e.code) {
			case 2:
				msg = [
					'Failed to load WinDivert driver file.',
					'Start TERA Proxy prior to any VPN software.',
					'Make sure anti-virus software did not delete required files.',
					'Open an administrator command prompt and enter \'sc stop windivert1.4\'.'
				]
				break
			case 5:
				msg = [
					'Access denied.',
					'Right click TeraProxy.bat and select \'Run as administrator\'.',
					'Disable or uninstall your anti-virus software.'
				]
				break
			case 577:
				msg = [
					'WinDivert driver signature could not be verified.',
					'Update Windows.',
					'If using Windows 7 or earlier, upgrade to a later version.'
				]
				break
			case 1275:
				msg = [
					'WinDivert driver was blocked.',
					'Uninstall your anti-virus software completely, then restart your computer.'
				]
				break
			case 1753:
				msg = [
					'Base Filtering Engine service is disabled.',
					'Run "services.msc".',
					'Right-click the "Base Filtering Engine" service, select \'Properties\'.',
					'Change \'Startup type\' to \'Automatic\', then click \'Start\'.'
				]
				break
			default:
				throw e
		}

		log.error(`${msg.shift()}${msg.length > 1 ? '\n' : ''}${msg.map(s => '\n* ' + s).join('')}`)
		process.exit(1)
	}

	log.info('OK')
	initialized = true
})().catch(e => {
	log.error(e)
	process.exit(1)
})