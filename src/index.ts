import { Context, Schema, Service } from 'koishi'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import * as tar from 'tar'
import fetch from 'node-fetch'

import type * as _sharp from 'sharp'
import { Stream } from 'stream'

export const name = 'qhzy-sharp'
export const filter = false

export interface Config { 
	nodeBinaryPath?: string,
	timeout?: number
}

export const Config: Schema<Config> = Schema.object({
	nodeBinaryPath: Schema.path({
		filters: ['directory'],
		allowCreate: true
	}).description('sharp 二进制文件路径')
	.default('data/assets/qhzy/sharp'),
	timeout: Schema.number().default(60000).description('超时时间(ms)')
})

const sharpVersion = '0.33.5'
const napiLabel = 'napi-v9'

declare module 'koishi' {
	interface Context {
		sharp: SharpService
	}
}


export class SharpService extends Service {
	Sharp: typeof _sharp

	declare readonly config: Required<Config>

	constructor(ctx: Context, config: Config) {
		super(ctx, 'sharp')
		this.config = {
			nodeBinaryPath: 'data/assets/qhzy/sharp',
			timeout: 60000,
			...config
		}
	}


	protected override async start() {
		this.ctx.logger.info('插件已经启动')
		const nodeDir = path.resolve(this.ctx.baseDir, this.config.nodeBinaryPath)
		// 确保 Skia 二进制文件的目录存在。
        fs.mkdirSync(nodeDir, { recursive: true })
        // 加载 Skia 的原生绑定，并将其属性合并到当前类实例中。
        const s = await this.getNativeBinding()
		this.Sharp = s
	}

	private async handleSharp(fileName:string,filePath:string) {
		return new Promise<void>((resolve,reject)=>{	
			const tmpFile = path.join(os.tmpdir(),fileName)
			// 清理创建临时目录
			fs.rmSync(tmpFile, {recursive:true,force:true})
			fs.mkdirSync(tmpFile)
			const tmp = path.join(tmpFile, fileName + '.tar.gz')
			const url = `https://registry.npmmirror.com/-/binary/sharp/v${sharpVersion}/${fileName}.tar.gz`
			this.ctx.logger.info(`正在下载 ${url}`)
			this.downloadFile(url,tmp).then(() => {
				this.ctx.logger(`文件已成功下载到${tmp}，开始解压...`)
				const unzip = zlib.createGunzip()
				const tarExtract = tar.x({
					cwd: tmpFile
				})
				fs.createReadStream(tmp)
					.pipe(unzip)
					.pipe(tarExtract)
					.on('finish', ()=>{
						this.ctx.logger.info(`文件解压完成`)
						fs.renameSync(path.join(tmpFile, 'v9/sharp.node'), filePath)
						// 延迟删除临时目录
						setTimeout(()=>{
							try{
								fs.rmSync(tmpFile, {recursive:true,force:true})
								this.ctx.logger.info(`${tmpFile}已删除`)
							} catch(err) {
								this.ctx.logger.warn(`${tmpFile}删除失败，请手动删除`)
							}
							resolve()
						}, 300)
					})
					.on('error',(err)=>{
						this.ctx.logger.warn(`解压失败，请手动解压文件到${tmpFile}`)
						reject(err)
					})
			})
		})
	}

	/**
	 * 判断当前平台是否支持sharp，并返回平台信息
	 * 1.darwin-arm64
	 * 2.darwin-x64
	 * 3.emscripten-wasm32
	 * 4.linux-arm
	 * 5.linux-arm64
	 * 6.linux-s390x
	 * 7.linux-x64
	 * 8.linuxmusl-arm64
	 * 9.linuxmusl-x64
	 * 10.win32-ia32
	 * 11.win32-x64
	 */
	private async getNativeBinding() {
		const nodeDir = path.resolve(this.ctx.baseDir, this.config.nodeBinaryPath)
		const { platform, arch } = process
        let nativeBinding: any

        // 不同平台和架构的映射关系，用于确定正确的二进制文件名。
        const platformArchMap = {
			win32: {
				x64: `sharp-v${sharpVersion}-${napiLabel}-win32-x64`,
				ia32: `sharp-v${sharpVersion}-${napiLabel}-win32-ia32`
			},
			darwin: {
				x64: `sharp-v${sharpVersion}-${napiLabel}-darwin-x64`,
				arm64: `sharp-v${sharpVersion}-${napiLabel}-darwin-arm64`
			},
			linux: {
				x64: `sharp-v${sharpVersion}-${napiLabel}-linux${this.isMusl() ? 'musl' : ''}-x64`,
				arm64: `sharp-v${sharpVersion}-${napiLabel}-linux${this.isMusl() ? 'musl' : ''}-arm64`,
				arm: `sharp-v${sharpVersion}-${napiLabel}-linux-arm`,
				s390x: `sharp-v${sharpVersion}-${napiLabel}-linux-s390x`
			}
        }
        if (!platformArchMap[platform]) {
            throw new Error(`Unsupported OS: ${platform}, architecture: ${arch}`)
        }
        if (!platformArchMap[platform][arch]) {
            throw new Error(`Unsupported architecture on ${platform}: ${arch}`)
        }

		// 根据平台和架构确定二进制文件名。
        const nodeName = platformArchMap[platform][arch]
		this.ctx.logger.info(`二进制文件名确定：${nodeName}`)

		const nodeFile = nodeName + '.node'
		this.ctx.logger.info(`二进制文件名确定：${nodeFile}`)
        const nodePath = path.join(nodeDir, 'package', nodeFile)
		this.ctx.logger.info(`二进制文件存储路径：${nodePath}`)

		// 确保包目录存在。
        fs.mkdirSync(path.join(nodeDir, 'package'), { recursive: true })
        const localFileExisted = fs.existsSync(nodePath)
		// 定义全局变量，用于在 sharp.js 中引用本地文件。
        global.__SKIA_DOWNLOAD_PATH = nodePath
		if(!localFileExisted) { // 如果本地文件不存在，下载并解压二进制文件
			this.ctx.logger.info('初始化 sharp 服务')
			await this.handleSharp(nodeName, nodePath)
			this.ctx.logger.info('sharp 服务初始化完成')
		}
		try {
			// 这个加载的文件从全局变量中导入相关库 ??
			nativeBinding = require('@quanhuzeyu/sharp-for-koishi')
		} catch (err) {
			this.ctx.logger.warn(`sharp 服务初始化失败，请手动下载 ${nodeName}.tar.gz 到 ${nodeDir}`)
			throw err
		}
		return nativeBinding	
	}


	/**
	 * 下载文件到指定路径。
	 * @param url 文件的 URL 地址。
	 * @param savePath 文件的本地保存路径。
	 */
	private async downloadFile(url: string, savePath: string): Promise<void> {
		const response = await fetch(url);

		if (!response.ok) {
			throw new Error(`无法下载文件，状态码: ${response.status}`);
		}

		const fileStream = fs.createWriteStream(savePath);
		
		await new Promise<void>((resolve, reject) => {
			response.body?.pipe(fileStream);
			response.body?.on('error', (err) => {
				reject(err);
			});
			fileStream.on('finish', () => {
				resolve();
			});
		});

		console.log(`文件已下载到: ${savePath}`);
	}


	private isMusl() {
        // 对于 Node 10 及以上版本的处理逻辑。
        if (!process.report || typeof process.report.getReport !== 'function') {
            try {
                const lddPath = require('child_process').execSync('which ldd').toString().trim()
                return fs.readFileSync(lddPath, 'utf8').includes('musl')
            } catch (e) {
                return true
            }
        } else {
            const report: { header: any } = process.report.getReport() as unknown as {
                header: any
            }
            const glibcVersionRuntime = report.header?.glibcVersionRuntime
            // 如果没有 glibc 运行时版本，则认为是使用 Musl。
            return !glibcVersionRuntime
        }
    }
}


export function apply(ctx: Context) {
	ctx.plugin(SharpService)
}