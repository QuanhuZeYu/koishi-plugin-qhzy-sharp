import { Context, Schema, Service } from 'koishi'
import path from 'path'
import * as wnode from 'koishi-plugin-w-node'

import type _sharp from '@quanhuzeyu/sharp-for-koishi'

const _srcDir = path.resolve(__dirname)

export const name = 'qhzy-sharp'
export const usage = `该服务通过w-node实现sharp，具体请先了解w-node用法`
export const filter = false
export const inject = ['node']

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
        await this.ctx.node.safeImport<typeof _sharp>(`sharp`)
        .then(sharp => {
            this.Sharp = sharp
        })
        .catch(err => {
            logger.error(err)
            logger.error('sharp加载失败，请检查sharp的版本是否正确')
        })
    }
}


export function apply(ctx: Context) {
	ctx.plugin(SharpService)
}