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
	sharpV?: string
}

export const Config: Schema<Config> = Schema.object({
	nodeBinaryPath: Schema.path({
		filters: ['directory'],
		allowCreate: true
	}).description('sharp 二进制文件路径')
	.default('data/assets/qhzy/sharp'),
	timeout: Schema.number().default(60000).description('超时时间(ms)'),
	sharpV: Schema.string().description('指定sharp的版本').default('0.33.5')
})

const sharpVersion = '0.33.5'
const napiLabel = 'napi-v9'

declare module 'koishi' {
	interface Context {
		QhzySharp: SharpService
	}
}


export class SharpService extends Service {
	Sharp: typeof _sharp
	tmpDir: string
	sharpV: string
	nodeBinaryPath: string

	declare readonly config: Required<Config>

	constructor(ctx: Context, config: Config) {
		super(ctx, 'QhzySharp')
		this.config = {
			nodeBinaryPath: path.resolve(ctx.baseDir, 'data/assets/qhzy/sharp'),
			timeout: 60000,
			sharpV: '0.33.5',
			...config,
		}
		this.tmpDir = path.resolve(ctx.baseDir,'data/assets/qhzy/sharp/tmp')
	}


	protected override async start() {
        this.ctx.logger.info(`插件已经启动，临时目录: ${this.tmpDir}`);
        await this.ensureDir(this.tmpDir);
        await this.ensureDir(path.resolve(this.ctx.baseDir, this.config.nodeBinaryPath));
        this.Sharp = await this.getNativeBinding();
        this.ctx.logger.info(`sharp 已成功加载`);
    }

	private async handleSharp(fileName: string, filePath: string): Promise<void> {
        const tmpFile = path.join(this.tmpDir, fileName);
        const tmpTarGz = path.join(tmpFile, `${fileName}.tar.gz`);
        const url = `https://registry.npmmirror.com/-/binary/sharp/v${sharpVersion}/${fileName}.tar.gz`;

        this.ctx.logger.info(`正在下载 ${url}`);

        await this.downloadFile(url, tmpTarGz);
        this.ctx.logger.info(`文件已成功下载到 ${tmpTarGz}`);

        const extractPath = path.dirname(filePath);
        this.ctx.logger.info(`开始解压文件到 ${extractPath}`);
        
        try {
            await this.extractAndClean(tmpTarGz, extractPath);
            this.ctx.logger.info(`文件解压完成，解压到: ${extractPath}`);
        } catch (err) {
            this.ctx.logger.error(`解压失败，错误信息: ${err.message}`);
            throw err;
        }
    }


	private async extractAndClean(tarFile: string, extractPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            fs.createReadStream(tarFile)
                .pipe(zlib.createGunzip()) // 解压 .gz
                .pipe(tar.extract({ cwd: extractPath })) // 解压 .tar
                .on('finish', async () => {
                    this.ctx.logger.info(`文件已解压到 ${extractPath}`);
                    await this.moveReleaseContents(extractPath);
                    await this.cleanup(tarFile, path.dirname(tarFile));
                    resolve();
                })
                .on('error', reject);
        });
    }


	/**
	 * 移动发布内容
	 * 将从指定的提取路径下的'build/Release'目录中的所有内容移动到上一级目录
	 * @param extractPath - 要提取内容的目录路径
	 * @returns Promise<void> - 不返回任何内容的Promise对象
	 */
	private async moveReleaseContents(extractPath: string): Promise<void> {
        const releaseDir = path.join(extractPath, 'build/Release');
        if (fs.existsSync(releaseDir)) {
			// 如果目录存在，获取该目录下的所有文件
            const files = fs.readdirSync(releaseDir);
			// 遍历文件列表，将每个文件移动到上一级目录
            for (const file of files) {
                fs.renameSync(path.join(releaseDir, file), path.join(extractPath, file));
            }
            fs.rmdirSync(releaseDir);
            this.ctx.logger.info(`目录 ${releaseDir} 内容已移动到 ${extractPath}`);
        } else {
            this.ctx.logger.info(`未找到目录 ${releaseDir}`);
        }
    }


	private async cleanup(file: string, dir: string): Promise<void> {
        try {
            fs.rmSync(file, { force: true });
            this.ctx.logger.info(`临时文件 ${file} 已删除`);
        } catch (err) {
            this.ctx.logger.warn(`删除临时文件 ${file} 失败，请手动删除`);
        }
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            this.ctx.logger.info(`临时目录 ${dir} 已删除`);
        } catch (err) {
            this.ctx.logger.warn(`删除临时目录 ${dir} 失败，请手动删除`);
        }
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
        const nodeDir = path.resolve(this.ctx.baseDir, this.config.nodeBinaryPath);
        const { platform, arch } = process;
        const platformArchMap = {
            win32: { x64: `sharp-v${sharpVersion}-${napiLabel}-win32-x64`, ia32: `sharp-v${sharpVersion}-${napiLabel}-win32-ia32` },
            darwin: { x64: `sharp-v${sharpVersion}-${napiLabel}-darwin-x64`, arm64: `sharp-v${sharpVersion}-${napiLabel}-darwin-arm64` },
            linux: {
                x64: `sharp-v${sharpVersion}-${napiLabel}-linux${this.isMusl() ? 'musl' : ''}-x64`,
                arm64: `sharp-v${sharpVersion}-${napiLabel}-linux${this.isMusl() ? 'musl' : ''}-arm64`,
                arm: `sharp-v${sharpVersion}-${napiLabel}-linux-arm`,
                s390x: `sharp-v${sharpVersion}-${napiLabel}-linux-s390x`,
            },
        };

        if (!platformArchMap[platform] || !platformArchMap[platform][arch]) {
            throw new Error(`Unsupported platform or architecture: ${platform}-${arch}`);
        }

        const nodeName = platformArchMap[platform][arch];
		// this.ctx.logger.info(`nodeName: ${nodeName}`)
        const nodeFile = `${nodeName}.node`;
        const nodePath = path.join(nodeDir, 'package', nodeFile);

        await this.ensureDir(path.dirname(nodePath));

        const localFileExisted = fs.readdirSync(path.dirname(nodePath)).some(file => file.endsWith('.node'));

        if (!localFileExisted) {
            this.ctx.logger.info('初始化 sharp 服务');
            await this.handleSharp(nodeName, nodePath);
            this.ctx.logger.info('sharp 服务初始化完成');
        }

        try {
            global.__QHZY_SHARP_PATH____ = path.join(nodeDir, 'package');
            return require('@quanhuzeyu/sharp-for-koishi');
        } catch (err) {
            this.ctx.logger.warn(`sharp 服务加载失败: ${path.join(nodeDir, 'package')}`);
            throw err;
        }
    }


	/**
	 * 下载文件到指定路径。
	 * @param url 文件的 URL 地址。
	 * @param savePath 文件的本地保存路径。
	 */
	private async downloadFile(url: string, savePath: string): Promise<void> {
		const dirPath = path.dirname(savePath);
		
		// 确保目标目录存在
		await fs.promises.mkdir(dirPath, { recursive: true });

		const file = fs.createWriteStream(savePath);
		const protocol = url.startsWith('https') ? https : http;

		return new Promise((resolve, reject) => {
			const download = (url: string) => {
				protocol.get(url, (response) => {
					if ([301, 302].includes(response.statusCode!)) {
						const location = response.headers.location;
						if (location) {
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
						resolve();
					});
					file.on('error', (err) => {
						fs.unlink(savePath, () => {});
						reject(err);
					});
				}).on('error', (err) => {
					fs.unlink(savePath, () => {});
					reject(err);
				});
			};
			download(url);
		});
	}


	private isMusl() {
        if (!process.report || typeof process.report.getReport !== 'function') {
            try {
                const lddPath = require('child_process').execSync('which ldd').toString().trim();
                return fs.readFileSync(lddPath, 'utf8').includes('musl');
            } catch (e) {
                return true;
            }
        } else {
            const report: { header: any } = process.report.getReport() as unknown as { header: any };
            return !report.header?.glibcVersionRuntime;
        }
    }

    private async ensureDir(dir: string) {
        try {
            await fs.promises.mkdir(dir, { recursive: true });
        } catch (err) {
            this.ctx.logger.error(`创建目录失败：${dir}`, err);
            throw err;
        }
    }
}


export function apply(ctx: Context) {
	ctx.plugin(SharpService)
}