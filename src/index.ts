import { Context, Schema, Service } from 'koishi'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import * as tar from 'tar'
import http from 'http'
import https from 'https'

import type _sharp from '@quanhuzeyu/sharp-for-koishi'
import { Stream } from 'stream'

const _srcDir = path.resolve(__dirname)

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
		Sharp: SharpService
	}
}


export class SharpService extends Service {
	Sharp: typeof _sharp
	tmpDir: string

	declare readonly config: Required<Config>

	constructor(ctx: Context, config: Config) {
		super(ctx, 'sharp')
		this.config = {
			nodeBinaryPath: 'data/assets/qhzy/sharp',
			timeout: 60000,
			...config
		}
		this.tmpDir = path.resolve(ctx.baseDir,'tmp')
	}


	protected override async start() {
		this.ctx.logger.info(`插件已经启动，临时目录: ${this.tmpDir}`)
		fs.mkdirSync(this.tmpDir, { recursive: true })
		const nodeDir = path.resolve(this.ctx.baseDir, this.config.nodeBinaryPath)
		// 确保 Skia 二进制文件的目录存在。
        fs.mkdirSync(nodeDir, { recursive: true })
        // 加载 Skia 的原生绑定，并将其属性合并到当前类实例中。
        const s = await this.getNativeBinding()
		this.Sharp = s[s.length-1]
	}

	private async handleSharp(fileName: string, filePath: string): Promise<void> {
		return new Promise<void>(async (resolve, reject) => {
			// 创建临时目录
			const tmpFile = path.join(this.tmpDir, fileName);
			if (fs.existsSync(tmpFile)) {
				fs.rmSync(tmpFile, { recursive: true, force: true });
			}
			fs.mkdirSync(tmpFile, { recursive: true });
	
			// 下载文件路径
			const tmp = path.join(tmpFile, fileName + '.tar.gz');
			const url = `https://registry.npmmirror.com/-/binary/sharp/v${sharpVersion}/${fileName}.tar.gz`;
	
			this.ctx.logger.info(`正在下载 ${url}`);
	
			try {
				// 下载文件
				await this.downloadFile(url, tmp);
				this.ctx.logger.info(`文件已成功下载到 ${tmp}`);
	
				// 解压缩到目标路径的上级目录
				const extractPath = path.dirname(filePath);
	
				this.ctx.logger.info(`开始解压文件到 ${extractPath}`);
	
				fs.createReadStream(tmp)
					.pipe(zlib.createGunzip()) // 解压 .gz
					.pipe(tar.extract({ cwd: extractPath })) // 解压 .tar
					.on('finish', () => {
						this.ctx.logger.info(`文件解压完成，解压到: ${extractPath}`);
	
						// 移动 build/Release 下的所有内容到解压目录
						const releaseDir = path.join(extractPath, 'build/Release');
						if (fs.existsSync(releaseDir)) {
							const files = fs.readdirSync(releaseDir);
							files.forEach(file => {
								const srcPath = path.join(releaseDir, file);
								const destPath = path.join(extractPath, file);
								fs.renameSync(srcPath, destPath);
							});
							// 删除空的 build/Release 目录
							fs.rmdirSync(releaseDir);
							this.ctx.logger.info(`目录 ${releaseDir} 内容已移动到 ${extractPath}`);
						} else {
							this.ctx.logger.info(`未找到目录 ${releaseDir}`);
						}
	
						// 延迟删除下载的压缩包
						setTimeout(() => {
							try {
								fs.rmSync(tmp, { force: true });
								this.ctx.logger.info(`临时文件 ${tmp} 已删除`);
							} catch (err) {
								this.ctx.logger.warn(`删除临时文件 ${tmp} 失败，请手动删除`);
							}
							// 删除临时目录
							try {
								fs.rmSync(tmpFile, { recursive: true, force: true });
								this.ctx.logger.info(`临时目录 ${tmpFile} 已删除`);
							} catch (err) {
								this.ctx.logger.warn(`删除临时目录 ${tmpFile} 失败，请手动删除`);
							}
							resolve();
						}, 300);
					})
					.on('error', (err) => {
						this.ctx.logger.error(`解压失败，错误信息: ${err.message}`);
						reject(err);
					});
			} catch (error) {
				this.ctx.logger.error(`下载失败，错误信息: ${error.message}`);
				reject(error);
			}
		});
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
		const packDir = path.join(nodeDir, 'package')

		// 确保包目录存在。
        fs.mkdirSync(packDir, { recursive: true })
        // 获取 nodePath 的上级目录
		const parentDir = path.dirname(nodePath);
		// 获取上级目录中的所有文件和目录
		const filesInParentDir = fs.readdirSync(parentDir);
		// 检查是否存在 .node 文件
		const localFileExisted = filesInParentDir.some(file => file.endsWith('.node'));
		// 定义全局变量，用于在 sharp.js 中引用本地文件。
        
		if(!localFileExisted) { // 如果本地文件不存在，下载并解压二进制文件
			this.ctx.logger.info('初始化 sharp 服务')
			await this.handleSharp(nodeName, nodePath)
			this.ctx.logger.info('sharp 服务初始化完成')
		}
		try {
			// 这个加载的文件从全局变量中导入相关库 ??
			global.__QHZY_SHARP_PATH____ = packDir
			nativeBinding = require('@quanhuzeyu/sharp-for-koishi')
		} catch (err) {
			this.ctx.logger.warn(`sharp 服务初始化失败: ${packDir}`)
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
		const file = fs.createWriteStream(savePath);
		const protocol = url.startsWith('https') ? https : http;
		
		return new Promise((resolve, reject) => {
			const download = (url: string) => {
				protocol.get(url, (response) => {
					if (response.statusCode === 302 || response.statusCode === 301) {
						// 重定向，获取新的 URL
						const location = response.headers.location;
						if (location) {
							// 递归处理重定向
							download(new URL(location, url).toString());
						} else {
							reject(new Error(`重定向失败，无法获取新 URL`));
						}
						return;
					}
					
					if (response.statusCode !== 200) {
						reject(new Error(`下载失败，状态码: ${response.statusCode}`));
						return;
					}
					
					response.pipe(file);
					
					file.on('finish', () => {
						file.close();
						resolve()
					});
					
					file.on('error', (err) => {
						fs.unlink(savePath, () => {}); // 删除文件
						reject(err);
					});
				}).on('error', (err) => {
					fs.unlink(savePath, () => {}); // 删除文件
					reject(err);
				});
			};

			download(url);
		});
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