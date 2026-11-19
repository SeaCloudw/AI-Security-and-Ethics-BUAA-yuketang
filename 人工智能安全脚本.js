// ==UserScript==
// @name         人工智能安全与伦理 - MD填空助手
// @namespace    local.ai.security.ethics
// @version      1.2.0
// @description  导入MD题库，支持手动填写与连续自动执行
// @match        https://buaa.yuketang.cn/v2/web/iframe-exercise/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
    'use strict';

    if (window.top === window) return;

    const KEY = 'ai_ethics_markdown_bank_v1';
    const NAMES = '一二三四五六七八九十';

    const CONFIG = {
        interval: 900,
        submitTimeout: 12000,
        nextTimeout: 8000,
        loadTimeout: 15000
    };

    let saved = GM_getValue(KEY, {
        filename: '',
        bank: {}
    });

    let running = false;
    let autoSubmit = false;
    let pending = null;
    let waitSince = null;

    // ==============================
    // 1. Markdown题库解析
    // ==============================

    function chapterIndex(raw) {
        if (/^\d+$/.test(raw)) {
            return Number(raw);
        }

        return NAMES.indexOf(raw) + 1;
    }

    function parseMarkdown(md) {
        const bank = {};

        let chapter = null;
        let question = null;
        let lines = [];

        function flush() {
            if (chapter !== null && question !== null) {

                const body = lines.join('\n');

                const answers = [
                    ...body.matchAll(/\*\*([\s\S]+?)\*\*/g)
                ].map(m => m[1].trim()).filter(Boolean);

                if (Object.hasOwn(bank[chapter], question)) {
                    throw new Error(
                        `重复题号：第${chapter}章第${question}题`
                    );
                }

                bank[chapter][question] = {
                    answers,
                    review: answers.some(a => /[/／$]/.test(a))
                };
            }

            question = null;
            lines = [];
        }

        for (const line of md.replace(/^\uFEFF/, '').split(/\r?\n/)) {

            // 识别章节标题
            const h = line.match(
                /^##\s+第([一二三四五六七八九十\d]+)章/
            );

            if (/^#{1,2}\s+/.test(line)) {

                flush();
                chapter = null;

                if (h) {
                    chapter = chapterIndex(h[1]);

                    if (chapter < 1) {
                        throw new Error('无法识别章节：' + h[1]);
                    }

                    bank[chapter] ||= {};
                }

                continue;
            }

            if (chapter === null) continue;

            // 识别题号
            const q = line.match(/^(\d+)[.．、]\s*(.*)$/);

            if (q) {
                flush();

                question = Number(q[1]);
                lines = [q[2]];

            } else if (
                question !== null &&
                !/^\s*!\[/.test(line)
            ) {
                lines.push(line);
            }
        }

        flush();

        return bank;
    }

    function stats(bank) {
        const chapters = Object.values(bank);
        const entries = chapters.flatMap(c => Object.values(c));

        return {
            chapters: chapters.length,
            all: entries.length,
            usable: entries.filter(e => e.answers.length).length
        };
    }

    // ==============================
    // 2. 识别课程及章节
    // ==============================

    function context() {
        try {
            const p = window.parent.document;

            const course = p.querySelector(
                '.learning-space-header__primary'
            )?.textContent || '';

            const title = p.querySelector(
                '.control-left .unit-title, .unit-title'
            )?.textContent || '';

            if (!course.includes('人工智能安全与伦理')) {
                return null;
            }

            const m = title.match(
                /第([一二三四五六七八九十\d]+)章/
            );

            if (!m) return null;

            const chapter = chapterIndex(m[1]);

            if (chapter < 1) return null;

            return {
                chapter,
                title: title.trim()
            };

        } catch (_) {
            return null;
        }
    }

    function visible(el) {
        if (!el || !el.getClientRects().length) {
            return false;
        }

        const style = getComputedStyle(el);

        return (
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            !el.hidden
        );
    }

    // ==============================
    // 3. 创建控制面板
    // ==============================

    const panel = document.createElement('section');

    panel.style.cssText = `
        position: fixed;
        right: 16px;
        top: 70px;
        width: 300px;
        z-index: 2147483647;
        background: #fff;
        color: #222;
        border: 2px solid #3976ec;
        border-radius: 10px;
        padding: 14px;
        font: 14px/1.5 sans-serif;
        box-shadow: 0 2px 12px #0003;
    `;

    panel.innerHTML = `
        <div style="font-size:16px;font-weight:bold">
            AI安全与伦理 · 填空助手
        </div>

        <div class="md-info"
             style="margin:10px 0;
                    white-space:pre-wrap;
                    overflow-wrap:anywhere">
        </div>

        <input type="file"
               accept=".md,.markdown,text/markdown,text/plain"
               hidden>

        <div style="
            display:grid;
            grid-template-columns:1fr 1fr;
            gap:8px;
        ">
            <button type="button" data-action="import">
                导入/更新MD
            </button>

            <button type="button" data-action="start">
                手动填写
            </button>

            <button type="button" data-action="auto">
                自动执行
            </button>

            <button type="button" data-action="stop">
                停止执行
            </button>
        </div>

        <div class="md-state"
             role="status"
             style="
                margin-top:12px;
                padding-top:10px;
                border-top:1px solid #ddd;
                white-space:pre-wrap;
                overflow-wrap:anywhere;
             ">
        </div>
    `;

    document.body.appendChild(panel);

    // 明确设置按钮样式
    panel.querySelectorAll('button').forEach(btn => {
        btn.style.cssText = `
            display:inline-block;
            padding:8px 10px;
            background:#f4f6f8;
            color:#222;
            border:1px solid #ccc;
            border-radius:6px;
            font-size:13px;
            cursor:pointer;
            text-align:center;
        `;
    });

    panel.querySelector('[data-action=auto]').style.background = '#3976ec';
    panel.querySelector('[data-action=auto]').style.color = '#fff';

    panel.querySelector('[data-action=stop]').style.background = '#dc3545';
    panel.querySelector('[data-action=stop]').style.color = '#fff';

    const fileInput = panel.querySelector('input[type=file]');
    const state = panel.querySelector('.md-state');
    const info = panel.querySelector('.md-info');

    function status(message) {
        state.textContent = message;
    }

    function refreshInfo() {
        const s = stats(saved.bank);

        info.textContent = s.all
            ? `${saved.filename}\n` +
              `${s.chapters}章 · ${s.usable}/${s.all}题有答案`
            : '尚未导入Markdown题库';
    }

    function stop(message) {
        running = false;
        pending = null;
        waitSince = null;

        status(message);
    }

    // ==============================
    // 4. 手动导入MD题库
    // ==============================

    panel.querySelector('[data-action=import]').onclick = () => {

        stop('请选择Markdown题库');

        fileInput.value = '';
        fileInput.click();
    };

    fileInput.addEventListener('change', async () => {

        const file = fileInput.files?.[0];

        if (!file) return;

        try {
            const md = await file.text();
            const bank = parseMarkdown(md);

            if (!stats(bank).usable) {
                throw new Error('未识别到有效题库答案');
            }

            const data = {
                filename: file.name,
                bank
            };

            // 持久化存储
            GM_setValue(KEY, data);

            saved = data;

            refreshInfo();

            status('题库导入成功');

            console.log('[填空助手] 题库：', bank);

        } catch (e) {
            stop('导入失败：' + e.message);
        }
    });

    // ==============================
    // 5. 控制按钮
    // ==============================

    function startExecution(auto) {

        if (running) {
            status('正在执行，请先停止当前任务');
            return;
        }

        if (!context()) {
            stop('未识别到目标课程及章节');
            return;
        }

        if (!stats(saved.bank).usable) {
            stop('请先导入MD题库');
            return;
        }

        autoSubmit = auto;
        running = true;
        pending = null;
        waitSince = null;

        status(
            auto
                ? '自动执行中...'
                : '正在填写当前题目...'
        );

        tick();
    }

    // 手动填写：只填写，不提交
    panel.querySelector('[data-action=start]').onclick = () => {
        startExecution(false);
    };

    // 自动执行：填写、提交、批改、下一题
    panel.querySelector('[data-action=auto]').onclick = () => {
        startExecution(true);
    };

    // 停止执行
    panel.querySelector('[data-action=stop]').onclick = () => {
        stop('已手动停止');
    };

    // ==============================
    // 6. 获取当前题目
    // ==============================

    function current() {
        const c = context();

        if (!c) return null;

        const items = [
            ...document.querySelectorAll('.subject-item')
        ].filter(el =>
            visible(el) &&
            el.querySelector(':scope > .item-type')
        );

        // 必须能唯一确定当前题目
        if (items.length !== 1) return null;

        const item = items[0];

        const heading = item.querySelector(
            ':scope > .item-type'
        ).textContent.trim();

        const match = heading.match(/^(\d+)\s*[.．、]/);

        if (!match) return null;

        const n = Number(match[1]);

        return {
            ...c,
            item,
            heading,
            n,
            key: `${c.chapter}:${n}`
        };
    }

    // 获取网页按钮
    function button(label) {

        const candidates = [
            ...document.querySelectorAll('.problem-box button')
        ].filter(b =>
            visible(b) &&
            b.textContent.trim() === label &&
            !b.disabled &&
            b.getAttribute('aria-disabled') !== 'true'
        );

        return candidates.length === 1
            ? candidates[0]
            : null;
    }

    // ==============================
    // 7. 判断批改结果
    // ==============================

    // 批改状态选择器尚未经过实际网页验证。
    // 无法确认回答正确时，停止自动执行。

    function gradeState(q) {

        const active = document.querySelector(
            '.problems-aside .subject-item.active'
        );

        const activeNumber = active?.textContent.match(
            /^\s*(\d+)/
        );

        if (
            activeNumber &&
            Number(activeNumber[1]) === q.n
        ) {

            // 回答错误
            if (active.querySelector(
                '.status-container .error, ' +
                '.status-container .wrong'
            )) {
                return 'wrong';
            }

            // 回答正确
            if (active.querySelector(
                '.status-container .success'
            )) {
                return 'correct';
            }
        }

        // 已批改但无法确认正确性
        if (/正确答案[:：]/.test(q.item.textContent)) {
            return 'unknown';
        }

        // 尚未批改
        return 'pending';
    }

    // ==============================
    // 8. 填空题输入框
    // ==============================

    function inputs(q) {

        return [
            ...q.item.querySelectorAll(
                '.item-body input.blank-item-dynamic[type=text]'
            )
        ].filter(el =>
            visible(el) &&
            !el.disabled &&
            !el.readOnly
        );
    }

    function fillInput(el, value) {

        el.value = value;

        el.dispatchEvent(
            new Event('input', {
                bubbles: true
            })
        );

        el.dispatchEvent(
            new Event('change', {
                bubbles: true
            })
        );
    }

    // ==============================
    // 9. 自动进入下一题
    // ==============================

    function goNext(q) {

        const next = button('下一题');

        if (!next) {

            stop(
                `第${q.chapter}章第${q.n}题回答正确。\n` +
                '没有可用的下一题按钮，执行结束。'
            );

            return;
        }

        pending = {
            key: q.key,
            phase: 'next',
            time: Date.now()
        };

        status(
            `第${q.chapter}章第${q.n}题回答正确\n` +
            '正在进入下一题...'
        );

        next.click();
    }

    // ==============================
    // 10. 核心执行逻辑
    // ==============================

    function tick() {

        if (!running) return;

        try {

            const q = current();

            // 等待题目加载
            if (!q) {

                waitSince ??= Date.now();

                if (Date.now() - waitSince > CONFIG.loadTimeout) {
                    stop('题目加载或识别超时');
                } else {
                    status('等待题目加载...');
                }

                return;
            }

            waitSince = null;

            const prefix = `第${q.chapter}章第${q.n}题`;

            // ------------------------------
            // 检查题目是否发生变化
            // ------------------------------

            // if (pending && pending.key !== q.key) {

            //     if (pending.phase !== 'next') {
            //         stop('题目意外发生变化，已停止');
            //         return;
            //     }

            //     pending = null;
            // }
if (pending && pending.key !== q.key) {

    if (pending.phase === 'submit') {

        const [prevChapter, prevNum] =
            pending.key.split(':').map(Number);

        // 检查是否正常顺序跳转
        if (
            q.chapter !== prevChapter ||
            q.n !== prevNum + 1
        ) {
            stop('题目异常跳转，已停止');
            return;
        }

        // 查找上一题的批改状态
        const previous = [
            ...document.querySelectorAll(
                '.problems-aside .subject-item'
            )
        ].find(el => {
            const m = el.textContent.match(/^\s*(\d+)/);
            return m && Number(m[1]) === prevNum;
        });

        if (previous?.querySelector(
            '.status-container .error, ' +
            '.status-container .wrong'
        )) {
            stop(`第${prevNum}题回答错误，已停止`);
            return;
        }

        if (previous?.querySelector(
            '.status-container .success'
        )) {
            pending = null;
        } else {
            if (Date.now() - pending.time > CONFIG.submitTimeout) {
                stop('无法确认上一题的批改结果');
            }
            return;
        }

    } else if (pending.phase === 'next') {

        pending = null;

    } else {

        stop('题目意外发生变化，已停止');
        return;
    }
}
            // ------------------------------
            // 等待进入下一题
            // ------------------------------

            if (pending?.phase === 'next') {

                if (
                    Date.now() - pending.time >
                    CONFIG.nextTimeout
                ) {
                    stop(prefix + '：下一题跳转超时');
                }

                return;
            }

            // ------------------------------
            // 检查批改结果
            // ------------------------------

            const grade = gradeState(q);

            // 回答错误，立即停止
            if (grade === 'wrong') {

                stop(
                    prefix +
                    '：回答错误！\n自动执行已停止。'
                );

                return;
            }

            // 无法确认结果，停止
            if (grade === 'unknown') {

                stop(
                    prefix +
                    '：无法确认批改结果，请人工检查'
                );

                return;
            }

            // ------------------------------
            // 等待提交后的批改
            // ------------------------------

            if (pending?.phase === 'submit') {

                if (grade === 'correct') {

                    goNext(q);

                } else if (
                    Date.now() - pending.time >
                    CONFIG.submitTimeout
                ) {

                    stop(prefix + '：等待批改结果超时');

                } else {

                    status(prefix + '：等待批改结果...');

                }

                return;
            }

            // ------------------------------
            // 仅处理填空题
            // ------------------------------

            if (!q.heading.includes('填空题')) {

                stop(prefix + '：当前不是填空题');

                return;
            }

            // ------------------------------
            // 已经回答正确
            // ------------------------------

            if (grade === 'correct') {

                if (autoSubmit) {
                    goNext(q);
                } else {
                    stop(prefix + '：已经回答正确');
                }

                return;
            }

            // ------------------------------
            // 获取题库答案
            // ------------------------------

            const entry = saved.bank[q.chapter]?.[q.n];

            if (!entry?.answers?.length) {

                stop(prefix + '：题库中没有答案');

                return;
            }

            const answers = entry.answers;

            // 特殊格式需要人工确认
            if (entry.review) {

                stop(
                    prefix +
                    '：存在公式或备选答案，请人工确认\n' +
                    answers.join('\n')
                );

                return;
            }

            // ------------------------------
            // 获取输入框
            // ------------------------------

            const els = inputs(q);

            if (els.length !== answers.length) {

                stop(
                    prefix + '：填空数量不匹配\n' +
                    `网页填空数：${els.length}\n` +
                    `题库答案数：${answers.length}`
                );

                return;
            }

            // ------------------------------
            // 已填写完成，准备提交
            // ------------------------------

            if (pending?.phase === 'filled') {

                const valid = els.every(
                    (el, i) => el.value === answers[i]
                );

                if (!valid) {

                    stop(prefix + '：填写结果验证失败');

                    return;
                }

                // 手动填写模式
                if (!autoSubmit) {

                    stop(
                        prefix +
                        '：填写完成，请手动提交\n' +
                        answers.join('、')
                    );

                    return;
                }

                // 自动执行模式
                const submit = button('提交');

                if (!submit) {

                    stop(prefix + '：提交按钮不可用');

                    return;
                }

                pending = {
                    key: q.key,
                    phase: 'submit',
                    time: Date.now()
                };

                status(
                    prefix + '：正在提交\n' +
                    answers.join('、')
                );

                submit.click();

                return;
            }

            // ------------------------------
            // 防止覆盖已有的不同答案
            // ------------------------------

            const conflict = els.some(
                (el, i) =>
                    el.value.trim() &&
                    el.value !== answers[i]
            );

            if (conflict) {

                stop(
                    prefix +
                    '：存在不同的已填写答案，请人工检查'
                );

                return;
            }

            // ------------------------------
            // 自动填写全部答案
            // ------------------------------

            els.forEach((el, i) => {

                if (el.value !== answers[i]) {
                    fillInput(el, answers[i]);
                }

            });

            pending = {
                key: q.key,
                phase: 'filled',
                time: Date.now()
            };

            status(
                prefix + '：已填写\n' +
                answers.map(
                    (a, i) => `第${i + 1}空：${a}`
                ).join('\n')
            );

        } catch (e) {

            stop('执行异常：' + e.message);

            console.error('[填空助手]', e);
        }
    }

    // ==============================
    // 11. 初始化
    // ==============================

    refreshInfo();

    status(
        '请选择操作\n' +
        '手动填写：填写当前题目\n' +
        '自动执行：连续填写、提交、下一题\n' +
        '仅在允许自动化的练习中使用'
    );

    setInterval(tick, CONFIG.interval);

})();