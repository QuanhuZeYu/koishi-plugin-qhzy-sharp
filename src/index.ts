import { Context, Schema, Service } from 'koishi'
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import * as tar from 'tar'
import http from 'http'
import https from 'https'

import type _sharp from '@quanhuzeyu/sharp-for-koishi'
import { exec, spawn } from 'child_process'

const _srcDir = path.resolve(__dirname)

export const name = 'qhzy-sharp'
export const usage = `因本人能力有限，sharp的libvips编译文件暂无法通过本脚本一站式解决\n\n
如果libvips不在二进制下载包中，请手动将对应的编译libvips放入nodeBinaryPath下@img目录中的对应架构文件夹中，下方设置中点开编辑Json即可查看对应的目录`
export const filter = false

export interface Config { 
	nodeBinaryPath: string,
	timeout: number
	sharpV: string
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

const napiLabel = 'napi-v9'

declare module 'koishi' {
	interface Context {
		QhzySharp: SharpService
	}
}


export class SharpService extends Service {
	Sharp: typeof _sharp
	tmpDir: string  /**临时目录: data/assets/qhzy/sharp/tmp */ = path.resolve(this.ctx.baseDir,'data/assets/qhzy/sharp/tmp')
	sharpV: string  /**sharp的版本  默认为0.33.5 */ = '0.33.5'
	nodeBinaryPath: string = 'data/assets/qhzy/sharp'

	declare readonly config: Required<Config>

	constructor(ctx: Context, config: Config) {
		super(ctx, 'QhzySharp')
        this.config = {
            nodeBinaryPath: 'data/assets/qhzy/sharp',
            timeout: 60000,
            sharpV: '0.33.5',
            ...config
        }
        this.tmpDir = path.resolve(ctx.baseDir,'data/assets/qhzy/sharp/tmp')
        this.sharpV = this.config.sharpV
        this.nodeBinaryPath = this.config.nodeBinaryPath
	}


	protected override async start() {
        const logger = this.ctx.logger
        logger.info(this.tmpDir, this.sharpV, this.nodeBinaryPath)
        logger.info(`插件已经启动，临时目录: ${this.tmpDir}`);
        await this.ensureDir(this.tmpDir);
        await this.ensureDir(path.resolve(this.ctx.baseDir, this.nodeBinaryPath));
        const isModel = await this.tryLoadSharp()
        if(isModel) {this.Sharp = isModel;return}
        const sharpPath = await this.fullDownloadSharp()
        await this.compileSharpAndMove(sharpPath)
        this.ctx.logger.info(`sharp 二进制文件已编译成功`)
        // this.Sharp = await this.getNativeBinding();
        this.cleanTMP()
        this.Sharp = await this.tryLoadSharp()
        this.ctx.logger.info(`sharp 已成功加载`);
    }

	private async handleSharp(fileName: string, filePath: string): Promise<void> {
        const tmpFile = path.join(this.tmpDir, fileName);
        const tmpTarGz = path.join(tmpFile, `${fileName}.tar.gz`);
        const url = `https://registry.npmmirror.com/-/binary/sharp/v${this.sharpV}/${fileName}.tar.gz`;

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
        const nodeDir = path.resolve(this.ctx.baseDir, this.nodeBinaryPath);
        const { platform, arch } = process;
        const platformArchMap = {
            win32: { x64: `sharp-v${this.sharpV}-${napiLabel}-win32-x64`, ia32: `sharp-v${this.sharpV}-${napiLabel}-win32-ia32` },
            darwin: { x64: `sharp-v${this.sharpV}-${napiLabel}-darwin-x64`, arm64: `sharp-v${this.sharpV}-${napiLabel}-darwin-arm64` },
            linux: {
                x64: `sharp-v${this.sharpV}-${napiLabel}-linux${this.isMusl() ? 'musl' : ''}-x64`,
                arm64: `sharp-v${this.sharpV}-${napiLabel}-linux${this.isMusl() ? 'musl' : ''}-arm64`,
                arm: `sharp-v${this.sharpV}-${napiLabel}-linux-arm`,
                s390x: `sharp-v${this.sharpV}-${napiLabel}-linux-s390x`,
            },
        };

        if (!platformArchMap[platform] || !platformArchMap[platform][arch]) {
            throw new Error(`Unsupported platform or architecture: ${platform}-${arch}`);
        }

        const nodeName = platformArchMap[platform][arch];
		// this.ctx.logger.info(`nodeName: ${nodeName}`)
        const nodeFile = `${nodeName}.node`;
        const nodePath = path.join(nodeDir, nodeFile);

        await this.ensureDir(path.dirname(nodePath));

        const localFileExisted = fs.readdirSync(path.dirname(nodePath)).some(file => file.endsWith('.node'));

        if (!localFileExisted) {
            this.ctx.logger.info('初始化 sharp 服务');
            await this.handleSharp(nodeName, nodePath);
            this.cleanTMP()
            this.ctx.logger.info('sharp 服务初始化完成');
        }

        try {
            global.__QHZY_SHARP_PATH____ = path.join(nodeDir);
            this.cleanTMP()
            return require('@quanhuzeyu/sharp-for-koishi');
        } catch (err) {
            this.ctx.logger.warn(`sharp 服务加载失败: ${path.join(nodeDir)}`);
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

    /**
     * 
     * @returns sharpPath sharp被下载的目录
     */
    private async fullDownloadSharp() {
        const version = this.sharpV
        const fullDLTmpDir = path.join(this.tmpDir, 'fullSharp')
        await this.ensureDir(fullDLTmpDir)
        const packageName = 'sharp'
        await this.installPackage(packageName, fullDLTmpDir)
        this.ctx.logger.info(`已下载 ${packageName} 包`)
        const sharpPath = path.join(fullDLTmpDir, 'node_modules', 'sharp')
        return sharpPath
    }

    /**
     * 在sharp目录下运行 npm install 来编译
     * 编译完成后，将 sharpPath 上级目录中的 '@img' 文件夹移动到 this.nodeBinaryPath 中
     * @param sharpPath sharp被下载的目录
     */
    private async compileSharpAndMove(sharpPath: string): Promise<void> {
        // 编译 sharp
        await new Promise<void>((resolve, reject) => {
            // 使用 `spawn` 执行 `npm install` 命令
            const installProcess = spawn('npm', ['install'], { cwd: sharpPath, shell: true });

            // 监听输出信息
            installProcess.stdout.on('data', (data) => {
                this.ctx.logger.info(`输出: ${data}`);
            });

            installProcess.stderr.on('data', (data) => {
                // this.ctx.logger.error(`错误输出: ${data}`);
            });

            // 监听进程关闭事件
            installProcess.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`npm install 进程退出，退出码: ${code}`));
                    return;
                }
                resolve();
            });

            // 监听进程错误事件
            installProcess.on('error', (err) => {
                reject(new Error(`无法执行 npm install 命令: ${err.message}`));
            });
        });

        // 获取 @img 文件夹路径
        const parentDir = path.dirname(sharpPath);
        const imgDir = path.join(parentDir, '@img');

        if (!fs.existsSync(imgDir)) {
            this.ctx.logger.error(`未找到目录: ${imgDir}`);
            return;
        }

        // 确保目标目录存在
        const targetDir = path.resolve(this.nodeBinaryPath);
        fs.mkdirSync(targetDir, { recursive: true });

        // 移动整个 @img 文件夹到目标路径
        const destPath = path.join(targetDir, '@img');

        try {
            fs.renameSync(imgDir, destPath);
            this.ctx.logger.info(`已将 ${imgDir} 目录移动到 ${destPath}`);
        } catch (err) {
            this.ctx.logger.error(`移动 @img 目录时发生错误: ${err.message}`);
        }
    }

    /**
     * 在指定目录中安装 npm 包
     * @param packageName 包名称
     * @param targetDir 目标目录
     */
    private async installPackage(packageName: string, targetDir: string): Promise<void> {
        // 在目标目录中创建一个新的空 package.json
        const packageJsonPath = path.join(targetDir, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            fs.writeFileSync(packageJsonPath, JSON.stringify({}), 'utf8');
        }
        return new Promise((resolve, reject) => {
            // 使用 spawn 执行 npm install 命令，并添加 --no-save 标志
            const npmInstall = spawn('npm', ['install', packageName, '--no-save'], { cwd: targetDir, shell: true });
            // 监听输出信息
            npmInstall.stdout.on('data', (data) => {
                // this.ctx.logger.info(`输出: ${data}`);
            });

            npmInstall.stderr.on('data', (data) => {
                // this.ctx.logger.error(`错误输出: ${data}`);
            });

            // 监听进程关闭事件
            npmInstall.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`npm install 进程退出，退出码: ${code}`));
                    return;
                }
                resolve();
            });
        });
    }

    /**
     * 清除文件夹 tmp
     */
    private cleanTMP() {
        const tmpDir = this.tmpDir
        if(fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true })
            this.ctx.logger(`临时文件夹已清除完毕: ${tmpDir}`)
        } else {
            this.ctx.logger(`临时文件夹不存在: ${tmpDir}; 跳过删除操作`)
        }
    }

    private tryLoadSharp() {
        let foundNodeDir: string | undefined;
        const logger = this.ctx.logger
        logger.info(`正在尝试寻找.node 文件`)
        const imgDir = path.resolve(this.config.nodeBinaryPath, '@img')
        logger.info(`寻找路径: ${imgDir}`)
        // 遍历imgDir寻找.node文件，.node所在的路径父级作为 global.__QHZY_SHARP_PATH____ 的值
        // 定义递归搜索函数
        const findNodeFileDir = (dir: string): string | undefined => {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const fullPath = path.join(dir, file);
                if (fs.statSync(fullPath).isDirectory()) {
                    // 如果是目录，则递归搜索
                    const result = findNodeFileDir(fullPath);
                    if (result) return result;
                } else if (file.endsWith('.node')) {
                    // 如果是 .node 文件，则返回其父目录
                    return dir;
                }
            }
            return undefined;
        };
        let nodeFilePath
        try {nodeFilePath = findNodeFileDir(imgDir)} catch (e) {logger.info(`没有找到.node，开始下载安装`);return false}
        const nodeFileDir = nodeFilePath ? path.resolve(imgDir, nodeFilePath) : undefined
        if(!nodeFileDir) {logger.info(`没有找到.node`);return false}
        else {
            global.__QHZY_SHARP_PATH____ = nodeFileDir
            const sharpModule = require('@quanhuzeyu/sharp-for-koishi')
            logger.info(`sharp已加载`)
            return sharpModule
        }
    }
}


export function apply(ctx: Context) {
	ctx.plugin(SharpService)
}