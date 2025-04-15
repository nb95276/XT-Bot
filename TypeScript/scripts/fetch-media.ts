import path from 'path';
import {get} from "lodash";
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import fs from "fs-extra";

// 配置时区插件
dayjs.extend(utc);
dayjs.extend(timezone);
const TZ_BEIJING = 'Asia/Shanghai';

// 类型定义 ------------------------------------------------------------------------
interface UserInfo {
    screenName: string;
    userId: string;
}

interface EnrichedTweet {
    user: {
        screenName: string;
        name: string;
    };
    images: string[];
    videos: string[];
    expandUrls: string[];
    tweetUrl: string;
    fullText: string;
    publishTime: string;
}

interface ProcessConfig {
    /** 输出目录路径，默认 './output' */
    outputDir?: string;
    /** 是否强制刷新用户信息，默认 false */
    forceRefresh?: boolean;
    /** 请求间隔时间（毫秒），默认 50000 */
    interval?: number;
}

// 主函数 -------------------------------------------------------------------------
/**
 * 主处理流程：根据用户名获取推文并处理
 * @param screenName 推特用户名（不含@）
 * @param client Twitter API 客户端
 * @param config 配置选项
 */
export async function processMediaByScreenName(
    screenName: string,
    client: any,
    config: ProcessConfig = {}
) {
    const startTime = Date.now();
    console.log(`===== ===== ===== ===== ===== ===== ===== ===== ===== =====`);
    console.log(`🚀 开始处理用户 @${screenName}`);

    try {
        // 合并配置参数
        const {
            outputDir = '../resp/respMedia',
            forceRefresh = false,
            interval = 50000
        } = config;

        // 步骤1: 获取用户ID ---------------------------------------------------------
        console.log('🔍 正在查询用户信息...');
        const userInfo = await getOrFetchUserInfo(screenName, client, forceRefresh);
        console.log(`✅ 获取用户信息成功：
          - 用户名: @${userInfo.screenName}
          - 用户ID: ${userInfo.userId}`);

        // 步骤2: 定义输出路径 -------------------------------------------------------
        const outputFileName = `${userInfo.screenName}.json`;
        const finalOutputPath = path.join('../tweets/user/', outputFileName);
        const rawOutputDir = path.join(outputDir);
        // 确保目录存在
        fs.ensureDirSync(path.dirname(finalOutputPath));
        fs.ensureDirSync(rawOutputDir);

        // 步骤3: 获取并处理推文 -----------------------------------------------------
        console.log('⏳ 开始获取推文数据...');
        const {processedCount, rawTweets} = await processTweets(
            userInfo.userId,
            client,
            {
                interval,
                rawOutputDir
            }
        );

        // 步骤4: 合并历史数据 -------------------------------------------------------
        console.log('🔄 正在合并历史数据...');
        const finalData = mergeAndSaveData(
            finalOutputPath,
            rawTweets,
            userInfo.userId
        );

        // 最终统计 -----------------------------------------------------------------
        const timeCost = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`
🎉 处理完成！
├── 用户：@${userInfo.screenName} (ID: ${userInfo.userId})
├── 本次获取：${processedCount} 条新推文
├── 历史累计：${finalData.length} 条推文
├── 耗时：${timeCost} 秒
└── 输出路径：${finalOutputPath}
        `);

        return finalData;

    } catch (error) {
        console.error(`❌ 处理用户 @${screenName} 失败：`, error);
        throw error;
    }
}

// 核心工具函数 -------------------------------------------------------------------
/**
 * 获取/缓存用户信息
 */
async function getOrFetchUserInfo(
    screenName: string,
    client: any,
    forceRefresh: boolean
): Promise<UserInfo> {
    const cacheDir = path.join('../resp/cache');
    const cachePath = path.join(cacheDir, `${screenName}.json`);

    // 尝试读取缓存
    if (!forceRefresh && fs.existsSync(cachePath)) {
        const cached = await fs.readJSON(cachePath);
        if (cached.userId) {
            console.log(`📦 使用缓存用户信息：@${screenName}`);
            return cached;
        }
    }

    // 调用API获取新数据
    console.log(`🌐 正在请求API获取用户信息：@${screenName}`);
    const response = await client.getUserApi().getUserByScreenName({screenName});

    if (!response.data?.user?.restId) {
        throw new Error(`未找到用户 @${screenName}`);
    }

    // 构建用户信息
    const userInfo: UserInfo = {
        screenName: screenName,
        userId: response.data.user.restId
    };

    // 写入缓存
    fs.ensureDirSync(cacheDir);
    await fs.writeJSON(cachePath, userInfo, {spaces: 2});
    return userInfo;
}

/**
 * 处理推文的核心流程
 */
async function processTweets(
    userId: string,
    client: any,
    options: {
        interval: number;
        rawOutputDir: string;
    }
) {
    let pageCount = 0;
    let fileCounter = 1;
    let processedCount = 0;
    const rawTweets: any[] = [];

    // 创建请求处理器
    const requestHandler = async (cursor?: string) => {
        pageCount++;

        // 添加请求开始日志
        console.log(`\n=== 第 ${pageCount} 次请求 ===`);
        console.log(`🕒 请求时间: ${new Date().toISOString()}`);
        console.log(`🎯 目标用户ID: ${userId}`);
        if (cursor) console.log(`📍 当前游标: ${cursor}`);

        // 间隔控制
        if (pageCount > 1) {
            console.log(`⏸️ 等待 ${options.interval / 1000} 秒...`);
            await new Promise(r => setTimeout(r, options.interval));
        }

        // 执行请求
        const response = await client.getTweetApi().getUserMedia({
            userId,
            cursor,
            count: 20
        });

        // 添加响应日志
        const responseCount = response.data?.data?.length || 0;
        console.log(`🔄 获取到 ${responseCount} 条推文`);

        // 记录原始数据
        if (response.data?.data?.length) {
            rawTweets.push(...response.data.data);
            console.log(`💾 内存暂存量: ${rawTweets.length} 条`);

            // 每50次请求写入文件
            if (pageCount % 50 === 0 && rawTweets.length > 0) {
                const filename = `${userId}_${fileCounter.toString().padStart(3, '0')}.json`;
                const filePath = path.join(options.rawOutputDir, filename);

                console.log(`🔄 达到分块阈值（50次请求），正在写入文件: ${filename}`);
                try {
                    await fs.writeFile(
                        filePath,
                        JSON.stringify(rawTweets, null, 2)
                    );
                } catch (err) {
                    console.error(`❌ 文件写入失败: ${filePath}`, err);
                    throw err; // 或实现重试逻辑
                }

                rawTweets.length = 0;  // 清空数组
                fileCounter++;
                console.log(`✅ 分块文件写入完成，已重置内存暂存`);
            }
        } else {
            console.log("⚠️ 本次请求未获取到数据");
        }

        return {
            data: {
                data: response.data?.data || [],
                cursor: response.data?.cursor
            }
        };
    };

    // 修改后的分页生成器
    const tweetGenerator = tweetCursor({limit: Infinity}, requestHandler);

    // 添加进度统计
    let totalFetched = 0;
    for await (const item of tweetGenerator) {
        processedCount++;
        totalFetched++;

        // 每50条输出进度
        if (processedCount % 50 === 0) {
            console.log(`📌 已处理 ${processedCount} 条（本次请求累计 ${totalFetched} 条）`);
        }
    }

    // 写入剩余数据（最后未满50次请求的部分）
    if (rawTweets.length > 0) {
        const filename = `${userId}_${fileCounter.toString().padStart(3, '0')}.json`;
        const filePath = path.join(options.rawOutputDir, filename);

        console.log(`📦 正在写入最终分块文件: ${filename}`);
        await fs.writeFile(filePath, JSON.stringify(rawTweets, null, 2));
    }

    console.log(`\n=== 请求结束 ===`);

    // 合并所有分块文件
    console.log(`\n🔗 开始合并分块文件...`);
    const fileTweets: any[] = [];

    try {
        const files = await fs.readdir(options.rawOutputDir);
        // 按文件名排序确保顺序正确
        files.sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
        for (const file of files) {
            if (file.startsWith(`${userId}_`) && file.endsWith('.json')) {
                const filePath = path.join(options.rawOutputDir, file);

                console.log(`⏳ 正在读取分块文件: ${file}`);
                const data = await fs.readFile(filePath, 'utf-8');
                fileTweets.push(...JSON.parse(data));
            }
        }
    } catch (err) {
        console.error('❌ 文件合并失败:', err);
        throw err;
    }

    console.log(`📈 总计获取: ${totalFetched} 条`);
    console.log(`✅ 合并完成，总计加载 ${fileTweets.length} 条原始推文`);

    // 🚨 需要验证数据一致性（可添加检查）
    if (totalFetched !== fileTweets.length) {
        console.warn(`⚠️ 警告：请求获取数（${totalFetched}）与文件加载数（${fileTweets.length}）不一致`);
    }

    // 在获取原始推文后新增回复处理
    const collectedReplies = collectNestedReplies(fileTweets);

    // 合并原始推文与回复推文
    const allTweets = [...fileTweets, ...collectedReplies];
    console.log(`🧩 合并推文：原始 ${fileTweets.length} 条 + 回复 ${collectedReplies.length} 条`);

    return {processedCount: allTweets.length, rawTweets: allTweets};
}

/**
 * 递归收集嵌套回复
 */
function collectNestedReplies(tweets: any[], maxDepth: number = 5): any[] {
    const recursiveCollect = (tweetList: any[], currentDepth: number): any[] => {
        if (currentDepth > maxDepth) return [];

        return tweetList.flatMap(item => {
            const replies = item.replies || [];
            return [
                ...replies,
                ...recursiveCollect(replies, currentDepth + 1)
            ];
        });
    };

    return recursiveCollect(tweets, 1);
}

/**
 * 数据合并与保存
 */
function mergeAndSaveData(
    outputPath: string,
    newTweets: any[],
    userId: string
): EnrichedTweet[] {
    // 读取历史数据
    let existingData: EnrichedTweet[] = [];
    try {
        if (fs.existsSync(outputPath)) {
            existingData = fs.readJSONSync(outputPath);
            console.log(`📚 读取到历史数据 ${existingData.length} 条`);
        }
    } catch (e) {
        console.warn('⚠️ 读取历史数据失败，将创建新文件:', e.message);
    }

    // 转换新数据
    console.log('🔄 正在处理原始推文数据...');
    const newData = newTweets
        .map(item => transformTweet(item, userId))
        .filter((t): t is EnrichedTweet => t !== null);

    // 统计转推数量
    const retweetCount = newTweets.filter(item => {
        const fullText = get(item, 'tweet.legacy.fullText', '').trim();
        return fullText.startsWith("RT @");
    }).length;

    // 无效数据统计
    const invalidCount = newTweets.length - newData.length;

    console.log(`\n=== 数据合并统计 ===`);
    console.log(`📥 新数据: ${newData.length} 条（原始 ${newTweets.length} 条）`);
    console.log(`🗑️ 过滤无效数据: ${invalidCount} 条（转推 ${retweetCount} 条）`);
    if (invalidCount > 0) {
        const hasNonRetweetInvalid = invalidCount !== retweetCount;
        if (hasNonRetweetInvalid) {
            console.log(`⚠️ 提示: 发现 ${invalidCount} 条无效数据（其中 ${invalidCount - retweetCount} 条非转推），请检查 rawOutputPath 或调整转换逻辑`);
        }
    }
    console.log(`📚 历史数据: ${existingData.length} 条`);

    // 合并去重
    const merged = [...existingData, ...newData];
    const uniqueMap = new Map(merged.map(t => [t.tweetUrl, t]));
    console.log(`🔍 去重后: ${uniqueMap.size} 条（减少 ${merged.length - uniqueMap.size} 条重复）`);

    // 按时间升序排序
    const sorted = Array.from(uniqueMap.values()).sort((a, b) =>
        a.publishTime.localeCompare(b.publishTime)
    );

    // 保存数据
    fs.writeFileSync(outputPath, JSON.stringify(sorted, null, 2));
    return sorted;
}

/**
 * 推文数据转换
 */
function transformTweet(item: any, userId: string): EnrichedTweet | null {
    // 安全访问工具函数
    const safeGet = (path: string, defaultValue: any = '') => get(item, path, defaultValue);

    /* 核心字段提取 */
    // 推文内容（使用完整文本字段）
    const fullText = safeGet('tweet.legacy.fullText', '');
    // 过滤转推
    if (fullText.trim().startsWith("RT @")) {
        return null;
    }
    // 推文发布时间（处理Twitter特殊日期格式）
    const createdAt = safeGet('tweet.legacy.createdAt', '');
    const beijingTime = convertToBeijingTime(createdAt);
    if (!beijingTime.isValid()) {
        console.log('🕒 时间解析失败:', createdAt);
        return null;
    }
    const publishTime = beijingTime.format('YYYY-MM-DDTHH:mm:ss');

    /* 用户信息提取 */
    const user = {
        screenName: safeGet('user.legacy.screenName', ''),
        name: safeGet('user.legacy.name', '')
    };

    /* 多媒体内容处理 */
    // 图片提取（类型为photo的媒体）
    const mediaItems = safeGet('tweet.legacy.extendedEntities.media', []);
    const images = mediaItems
        .filter((m: any) => m.type === 'photo')
        .map((m: any) => m.mediaUrlHttps)
        .filter(Boolean);

    // 视频提取（包括animated_gif类型）
    const videos = mediaItems
        .filter((m: any) => ['video', 'animated_gif'].includes(m.type))
        .map((m: any) => {
            const variants = m.videoInfo?.variants || [];
            return variants
                .filter((v: any) => v.contentType === 'video/mp4')
                .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0]?.url;
        })
        .filter(Boolean);

    /* 链接处理 */
    const expandUrls = safeGet('tweet.legacy.entities.urls', [])
        .map((u: any) => u.expandedUrl)
        .filter(Boolean);

    /* 推文URL构造 */
    const tweetId = safeGet('tweet.legacy.idStr', '');
    if (!tweetId || !user.screenName) {
        console.log(`❌ 无效推文结构`);
        return null;
    }
    const tweetUrl = `https://x.com/${user.screenName}/status/${tweetId}`;

    console.log(`✅ 转换成功：${tweetUrl}`);
    return {
        user,
        images,
        videos,
        expandUrls,
        tweetUrl,
        fullText,
        publishTime
    };
}

/**
 * 分页生成器实现
 */
async function* tweetCursor(
    params: { limit: number },
    request: (cursor?: string) => Promise<any>
) {
    let cursor: string | undefined;
    let count = 0;
    let emptyCount = 0;

    do {
        const response = await request(cursor);
        const tweets = response.data?.data || [];
        const newCursor = response.data?.cursor?.bottom?.value;

        // 添加分页日志
        console.log(`📌 累计已处理: ${count} 条`);

        // 终止条件判断
        if (tweets.length === 0) {
            emptyCount++;
            console.log(`❌ 空数据计数: ${emptyCount}/3`);
            if (emptyCount >= 3) {
                console.log("⏹️ 终止原因：连续3次空响应");
                return;
            }
        } else {
            emptyCount = 0;
        }

        // 处理数据
        for (const item of tweets) {
            yield item;
            if (++count >= params.limit) {
                console.log(`⏹️ 终止原因：达到数量限制（${params.limit}）`);
                return;
            }
        }

        cursor = newCursor;

    } while (true);
}

/**
 * 转换到北京时间
 */
function convertToBeijingTime(dateStr: string): dayjs.Dayjs {
    return dayjs(dateStr).tz(TZ_BEIJING);
}
