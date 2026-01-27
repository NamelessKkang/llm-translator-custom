import {
    eventSource,
    event_types,
    getRequestHeaders,
    reloadCurrentChat,
    saveSettingsDebounced,
    substituteParams,
    updateMessageBlock,
    callPopup,
} from '../../../../script.js';

import { extension_settings, getContext, saveMetadataDebounced } from '../../../extensions.js';
import { SECRET_KEYS, secret_state } from '../../../secrets.js';
import { POPUP_TYPE, callGenericPopup } from '../../../popup.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';

const DB_NAME = 'LLMtranslatorDB';
const STORE_NAME = 'translations';
const METADATA_BACKUP_KEY = 'llmTranslationCacheBackup'; // 메타데이터 백업 키
const RULE_PROMPT_KEY = 'llmRulePrompt'; // 규칙 프롬프트 메타데이터 키
const extensionName = "llm-translator-custom";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const DEBUG_MODE = false; // 디버그 로그 활성화 플래그

let extensionSettings = extension_settings[extensionName];
if (!extensionSettings) {
    extensionSettings = {};
    extension_settings[extensionName] = extensionSettings;
}

// 번역 진행 상태 추적 (단순화)
const translationInProgress = {};

// 디버그용 함수: 현재 번역 진행 상태 출력
function logTranslationStatus() {
    const activeTranslations = Object.entries(translationInProgress).filter(([id, status]) => status);
    console.log(`[DEBUG] Active translations:`, activeTranslations.length > 0 ? activeTranslations : 'None');
}

// 전역 디버그 함수 (콘솔에서 수동 호출 가능)
window.debugLLMTranslator = function () {
    console.log('=== LLM Translator Debug Info ===');
    console.log('Auto translate enabled:', extensionSettings.auto_translate_new_messages);
    console.log('Translation progress:', translationInProgress);
    console.log('Chat translation in progress:', isChatTranslationInProgress);
    logTranslationStatus();
    console.log('===================================');
};

// 전체 채팅 번역 상태 (기존 복잡한 플래그들 제거)
let isChatTranslationInProgress = false;

// 상태 플래그들이 단순화됨

// 기본 세팅
const defaultSettings = {
    translation_display_mode: 'disabled',
    llm_provider: 'openai',
    llm_model: 'gpt-4o-mini',
    provider_model_history: {
        openai: 'gpt-4o-mini',
        claude: 'claude-3-5-sonnet-20241022',
        google: 'gemini-2.5-pro',
        cohere: 'command',
        vertexai: 'gemini-2.5-pro'
    },
    custom_model: '',                        // 커스텀 모델명
    throttle_delay: '0',
    show_input_translate_button: false,
    auto_translate_new_messages: false,      // 새 메시지 자동 번역 (AI메시지, 유저메시지, 스와이프)
    force_sequential_matching: false,        // 문단 순차 매칭 사용
    hide_legacy_translate_button: false,     // 기존 번역 아이콘(뇌) 숨기기
    hide_toggle_button: false,               // 번역 전환 아이콘(돋보기) 숨기기  
    hide_new_translate_button: true,         // 번역/전환 아이콘(좌우화살표) 숨기기
    hide_paragraph_button: true,             // 문단 수 교정 아이콘(렌치) 숨기기
    hide_edit_button: false,                 // 번역 수정 아이콘(펜) 숨기기
    hide_delete_button: true,                // 번역 삭제 아이콘(쓰레기통) 숨기기
    use_reverse_proxy: false,
    reverse_proxy_url: '',
    reverse_proxy_password: '',
    llm_prompt_chat: 'Please translate the following text to korean:',
    llm_prompt_retranslate_correction: `# 역할
당신은 '최소 수정 원칙(Principle of Minimal Intervention)'을 따르는 번역 교정 전문가입니다. 당신의 임무는 원문의 스타일과 표현을 보존하면서, 명백한 오류만 외과수술처럼 정밀하게 수정하는 것입니다.

# 핵심 지침
* **절대 재창작 금지:** 텍스트에 있는 온전한 문장들을 더 나은 표현으로 재구성하려 하지 마세요.
* **오류만 수정:** 아래 '수정 규칙'에 위배되는 부분만 찾아 수정하고, 그 외의 모든 부분은 그대로 유지해야 합니다.

# 수정 규칙
1.  **뜬금없는 외국어:** 번역문에 한국어와 필수 외래어를 제외한 뜬금없는 외국어 단어(러시아어, 키릴 문자 등)가 있다면 자연스러운 한국어로 다시 번역합니다.
3.  **추가 규칙:** 추가 규칙 프롬프트가 존재한다면 번역문은 이를 따라야합니다.

# 출력 형식
* 다른 설명이나 인사 없이, 오직 최종적으로 완성된 번역문 전체만 제공해야 합니다.`,
    llm_prompt_retranslate_guidance: `# 역할
당신은 한국어 번역 교정 전문가입니다. 당신의 임무는 불안정한 초안 번역을 아래의 지침에 따라 정밀하게 교정하는 것입니다.

# 핵심 지침
* **재창작 금지:** 텍스트에 있는 모든 문장들을 더 나은 표현으로 재구성하려 하지 마세요.
* **지침 따르기:** 아래의 '추가 지침'에 해당되는 문장들만 수정하고, 그 외의 모든 부분은 그대로 유지해야 합니다.

# 출력 형식
* 다른 설명이나 인사 없이, 오직 최종적으로 완성된 번역문 전체만 제공해야 합니다.`,
    llm_prompt_retranslate_paragraph: `# 역할
당신은 텍스트 구조 교정가입니다. 현재 초안 번역문에는 줄 바꿈, 문단 개수가 원문과 일치하지않는 문제가 있습니다. 원문의 형식과 정확히 일치하도록 번역문을 교정해주세요.

# 주의사항
* **불필요한 번역 교정 금지:** 텍스트에 있는 문장들을 더 나은 표현으로 재구성하려 하지 마세요. 당신은 번역 교정가가 아닌 구조 교정가입니다.
* **지침 따르기:** 아래의 문제가 발생한 사례만 파악하여 구조를 교정해주세요.

# 지침:
1. 줄바꿈 규칙
   - 원문의 모든 줄바꿈을 번역문에 동일하게 유지
   - 한 줄 띄움과 두 줄 띄움을 구분하여 정확히 반영
   - 임의로 줄바꿈을 추가하거나 제거하지 않음

2. 구조적 일치
   - 원문과 번역문의 문단 수 일치
   - 각 문단의 위치와 순서 유지

3. 내용 점검
   - 원문에 없는 추가 문단 제거
   - 원문에서 누락된 문단이 있다면 추가

# 출력 형식
* 다른 설명이나 인사 없이, 오직 최종적으로 완성된 번역문 전체만 제공해야 합니다.`,
    llm_prompt_input: 'Please translate the following text to english:',
    llm_prefill_toggle: false,
    llm_prefill_content: 'Understood. Executing the translation as instructed. Here is the translation:',
    selected_translation_prompt_id: null,  // 선택된 프롬프트 ID
    selected_translation_prompt: null,     // 선택된 프롬프트 내용
    context_message_count: 5,              // {{llmContext}} 메시지 수
    context_include_user: false,           // {{llmContext}} 유저 메시지 포함 여부
    context_exclude_last: true,            // {{llmContext}} 마지막 메시지 제외 (채팅번역시)
    customPrompts: [],                      // 커스텀 프롬프트 목록
    presets: [],                            // 프리셋 목록
    temperature: 0.7,
    max_tokens: 1000,
    parameters: {
        openai: {
            max_length: 1000,
            temperature: 0.7,
            frequency_penalty: 0.2,
            presence_penalty: 0.5,
            top_p: 0.99
        },
        claude: {
            max_length: 1000,
            temperature: 0.7,
            top_k: 0,
            top_p: 0.99
        },
        cohere: {
            max_length: 1000,
            temperature: 0.7,
            frequency_penalty: 0,
            presence_penalty: 0,
            top_k: 0,
            top_p: 0.99
        },
        google: {
            max_length: 1000,
            temperature: 0.7,
            top_k: 0,
            top_p: 0.99
        },
        vertexai: {
            max_length: 1000,
            temperature: 0.7,
            top_k: 0,
            top_p: 0.99
        }
    }
};

// 기본 설정 로드, UI 초기화
function loadSettings() {
    // 기본 설정 불러오기
    for (const key in defaultSettings) {
        if (!extensionSettings.hasOwnProperty(key)) {
            extensionSettings[key] = defaultSettings[key];
        }
    }

    // 설정 마이그레이션: auto_translate_on_swipe → auto_translate_new_messages
    if (extensionSettings.hasOwnProperty('auto_translate_on_swipe') && !extensionSettings.hasOwnProperty('auto_translate_new_messages')) {
        extensionSettings.auto_translate_new_messages = extensionSettings.auto_translate_on_swipe;
        delete extensionSettings.auto_translate_on_swipe;
        saveSettingsDebounced();
    }

    // 파라미터 없으면 기본 파라미터로 초기화
    if (!extensionSettings.parameters) {
        extensionSettings.parameters = defaultSettings.parameters;
    }

    // 공급자 사용 이력 없으면 기본 설정으로 초기화
    if (!extensionSettings.provider_model_history) {
        extensionSettings.provider_model_history = defaultSettings.provider_model_history;
    }

    // 현재 선택된 공급자와 프롬프트를 UI에 설정
    const currentProvider = extensionSettings.llm_provider;
    $('#llm_provider').val(currentProvider);

    // 숨겨진 텍스트 영역들에 각 프롬프트 값 설정
    $('#llm_prompt_chat').val(extensionSettings.llm_prompt_chat);
    $('#llm_prompt_retranslate_correction').val(extensionSettings.llm_prompt_retranslate_correction);
    $('#llm_prompt_retranslate_guidance').val(extensionSettings.llm_prompt_retranslate_guidance);
    $('#llm_prompt_retranslate_paragraph').val(extensionSettings.llm_prompt_retranslate_paragraph);
    $('#llm_prompt_input').val(extensionSettings.llm_prompt_input);
    $('#llm_prefill_content').val(extensionSettings.llm_prefill_content);

    // 현재 공급자의 파라미터 불러오기
    updateParameterVisibility(currentProvider);
    loadParameterValues(currentProvider);

    // 현재 공급자의 마지막 사용 모델 불러오기
    updateModelList();

    // 프리필 사용 여부 로드
    $('#llm_prefill_toggle').prop('checked', extensionSettings.llm_prefill_toggle);

    // 스로틀링 딜레이 값
    $('#throttle_delay').val(extensionSettings.throttle_delay || '0');

    // 체크박스 상태 설정 및 버튼 업데이트
    $('#llm_translation_button_toggle').prop('checked', extensionSettings.show_input_translate_button);
    updateInputTranslateButton();

    // 새 메시지 자동 번역 체크박스 상태 설정
    $('#auto_translate_new_messages').prop('checked', extensionSettings.auto_translate_new_messages);
    $('#force_sequential_matching').prop('checked', extensionSettings.force_sequential_matching);

    // llmContext 설정 로드
    $('#llm_context_message_count').val(extensionSettings.context_message_count || 5);
    $('#llm_context_message_count_value').val(extensionSettings.context_message_count || 5);
    $('#llm_context_include_user').prop('checked', extensionSettings.context_include_user);
    $('#llm_context_exclude_last').prop('checked', extensionSettings.context_exclude_last !== false);

    // 리버스 프록시 설정 로드
    $('#llm_use_reverse_proxy').prop('checked', extensionSettings.use_reverse_proxy);
    $('#llm_reverse_proxy_url').val(extensionSettings.reverse_proxy_url);
    $('#llm_reverse_proxy_password').val(extensionSettings.reverse_proxy_password);

    // 아이콘 표시/숨김 설정 로드
    $('#hide_legacy_translate_button').prop('checked', extensionSettings.hide_legacy_translate_button);
    $('#hide_toggle_button').prop('checked', extensionSettings.hide_toggle_button);
    $('#hide_new_translate_button').prop('checked', extensionSettings.hide_new_translate_button);
    $('#hide_paragraph_button').prop('checked', extensionSettings.hide_paragraph_button);
    $('#hide_edit_button').prop('checked', extensionSettings.hide_edit_button);
    $('#hide_delete_button').prop('checked', extensionSettings.hide_delete_button);

    const displayMode = extensionSettings.translation_display_mode || defaultSettings.translation_display_mode;
    $('#translation_display_mode').val(displayMode);

    // 규칙 프롬프트 로드
    loadRulePrompt();

    // 프롬프트 선택 상태 복원
    if (promptManager) {
        const savedPromptId = extensionSettings.selected_translation_prompt_id;
        const promptSelect = document.getElementById('prompt_select');

        if (savedPromptId && promptSelect) {
            promptSelect.value = savedPromptId;
            const selectedPrompt = promptManager.getSelectedPrompt();
            if (selectedPrompt) {
                extensionSettings.selected_translation_prompt = selectedPrompt.content;
                logDebug('Restored translation prompt:', selectedPrompt.title);
            }
        }

        // 텍스트 필드에 프롬프트 로드 (항상 실행)
        promptManager.loadPromptToEditor();
    }
}

// 규칙 프롬프트 관리 함수
function loadRulePrompt() {
    const context = getContext();
    if (context && context.chatMetadata) {
        const rulePrompt = context.chatMetadata[RULE_PROMPT_KEY] || '';
        $('#llm_rule_prompt').val(rulePrompt);
    }
}

function saveRulePrompt() {
    const context = getContext();
    if (context) {
        if (!context.chatMetadata) {
            context.chatMetadata = {};
        }
        const rulePrompt = $('#llm_rule_prompt').val();
        context.chatMetadata[RULE_PROMPT_KEY] = rulePrompt;
        saveMetadataDebounced();
    }
}

// 프롬프트 관리는 이제 PromptManager 클래스에서 처리됩니다



// 리버스 프록시 설정 저장
function saveReverseProxySettings() {
    extensionSettings.use_reverse_proxy = $('#llm_use_reverse_proxy').is(':checked');
    extensionSettings.reverse_proxy_url = $('#llm_reverse_proxy_url').val();
    extensionSettings.reverse_proxy_password = $('#llm_reverse_proxy_password').val();
    saveSettingsDebounced();
}

// 파라미터 섹션 표시/숨김
function updateParameterVisibility(provider) {
    // 모든 파라미터 그룹 숨기기
    $('.parameter-group').hide();
    // 선택된 공급자의 파라미터 그룹만 표시
    $(`.${provider}_params`).show();
}

// 선택된 공급자의 파라미터 값을 입력 필드에 로드
function loadParameterValues(provider) {
    const params = extensionSettings.parameters[provider];
    if (!params) return;

    // 모든 파라미터 입력 필드 초기화
    $(`.${provider}_params input`).each(function () {
        const input = $(this);
        const paramName = input.attr('id').replace(`_${provider}`, '');

        if (params.hasOwnProperty(paramName)) {
            const value = params[paramName];

            // 슬라이더, 입력 필드 모두 업데이트
            if (input.hasClass('neo-range-slider')) {
                input.val(value);
                input.next('.neo-range-input').val(value);
            } else if (input.hasClass('neo-range-input')) {
                input.val(value);
                input.prev('.neo-range-slider').val(value);
            }
        }
    });

    // 공통 파라미터 업데이트
    ['max_length', 'temperature'].forEach(param => {
        if (params.hasOwnProperty(param)) {
            const value = params[param];
            const input = $(`#${param}`);
            if (input.length) {
                input.val(value);
                input.prev('.neo-range-slider').val(value);
            }
        }
    });
}

// 선택된 공급자의 파라미터 값을 저장
function saveParameterValues(provider) {
    const params = { ...extensionSettings.parameters[provider] };

    // 공통 파라미터 저장
    params.max_length = parseInt($('#max_length').val());
    params.temperature = parseFloat($('#temperature').val());

    // 공급자별 파라미터 저장
    $(`.${provider}_params input.neo-range-input`).each(function () {
        const paramName = $(this).attr('id').replace(`_${provider}`, '');
        params[paramName] = parseFloat($(this).val());
    });

    extensionSettings.parameters[provider] = params;
    saveSettingsDebounced();
}

// 공급자별 특정 파라미터 추출
function getProviderSpecificParams(provider, params) {
    switch (provider) {
        case 'openai':
            return {
                frequency_penalty: params.frequency_penalty,
                presence_penalty: params.presence_penalty,
                top_p: params.top_p
            };
        case 'claude':
            return {
                top_k: params.top_k,
                top_p: params.top_p
            };
        case 'cohere':
            return {
                frequency_penalty: params.frequency_penalty,
                presence_penalty: params.presence_penalty,
                top_k: params.top_k,
                top_p: params.top_p
            };
        case 'google':
            return {
                top_k: params.top_k,
                top_p: params.top_p
            };
        case 'vertexai':
            return {
                top_k: params.top_k,
                top_p: params.top_p
            };
        default:
            return {};
    }
}

// 선택된 공급자의 모델 목록 업데이트
function updateModelList() {
    const provider = $('#llm_provider').val();
    const modelSelect = $('#llm_model');
    modelSelect.empty();

    const models = {
        'openai': [
            'gpt-5.2',
            'gpt-5-mini',
            'gpt-5-nano',
            'chatgpt-4o-latest',
            'gpt-4o',
            'gpt-4o-2024-11-20',
            'gpt-4o-2024-08-06',
            'gpt-4o-2024-05-13',
            'gpt-4o-mini',
            'gpt-4o-mini-2024-07-18',
            'o1',
            'o1-2024-12-17',
            'o1-preview',
            'o1-preview-2024-09-12',
            'o1-mini',
            'o1-mini-2024-09-12',
            'gpt-4-turbo',
            'gpt-4-turbo-2024-04-09',
            'gpt-4-turbo-preview',
            'gpt-4-0125-preview',
            'gpt-4-1106-preview',
            'gpt-4',
            'gpt-4-0613',
            'gpt-4-0314',
            'gpt-4-32k',
            'gpt-3.5-turbo',
            'gpt-3.5-turbo-0125',
            'gpt-3.5-turbo-1106',
            'gpt-3.5-turbo-instruct'
        ],
        'claude': [
            'claude-3-5-sonnet-latest',
            'claude-3-5-sonnet-20241022',
            'claude-3-5-sonnet-20240620',
            'claude-3-5-haiku-latest',
            'claude-3-5-haiku-20241022',
            'claude-3-opus-latest',
            'claude-3-opus-20240229',
            'claude-3-sonnet-20240229',
            'claude-3-haiku-20240307',
            'claude-2.1',
            'claude-2.0'
        ],
        'google': [
            'gemini-3-pro-preview',
            'gemini-3-flash-preview',
            'gemini-2.5-pro',
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite',
            'gemini-2.0-flash',
            'gemini-2.0-flash-lite'
        ],
        'cohere': [
            'command-r7b-12-2024',
            'command-r-plus',
            'command-r-plus-08-2024',
            'command-r',
            'command-r-08-2024',
            'c4ai-aya-expanse-8b',
            'c4ai-aya-expanse-32b'
        ],
        'vertexai': [
            'gemini-3-pro-preview',
            'gemini-3-flash-preview',
            'gemini-2.5-pro',
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite',
            'gemini-2.0-flash',
            'gemini-2.0-flash-lite',
            'gemini-1.5-pro-latest',
            'gemini-1.5-pro',
            'gemini-1.5-flash-latest',
            'gemini-1.5-flash'
        ]
    };

    const providerModels = models[provider] || [];
    for (const model of providerModels) {
        modelSelect.append(`<option value="${model}">${model}</option>`);
    }
    // 맨 아래에 custom 옵션 추가
    modelSelect.append(`<option value="custom">⚙️ 커스텀 모델 입력</option>`);

    // 해당 공급자의 마지막 사용 모델을 선택
    const lastUsedModel = extensionSettings.provider_model_history[provider] || providerModels[0];
    modelSelect.val(lastUsedModel);

    // custom 선택시 커스텀 입력에 기존 값 표시
    if (lastUsedModel === 'custom') {
        $('#custom_model_container').show();
        $('#llm_custom_model').val(extensionSettings.custom_model || '');
    } else {
        $('#custom_model_container').hide();
    }

    // 모델과 공급자 이력 업데이트
    extensionSettings.llm_model = lastUsedModel;
    extensionSettings.provider_model_history[provider] = lastUsedModel;
}

// 커스텀 플레이스홀더 치환 함수
function substituteCustomPlaceholders(prompt, isInputTranslation = false) {
    if (!prompt.includes('{{llmContext}}')) {
        return prompt;
    }

    const count = extensionSettings.context_message_count || 5;
    const includeUser = extensionSettings.context_include_user || false;
    const excludeLast = extensionSettings.context_exclude_last && !isInputTranslation;
    const context = getContext();

    if (!context?.chat?.length) {
        return prompt.replace(/\{\{llmContext\}\}/g, '');
    }

    let messages;
    if (excludeLast) {
        // 채팅 번역시 마지막 메시지 제외 (번역 대상과 중복 방지)
        messages = context.chat
            .slice(-count - 1, -1)
            .filter(m => includeUser || !m.is_user)
            .map(m => m.mes)
            .join('\n\n');
    } else {
        messages = context.chat
            .slice(-count)
            .filter(m => includeUser || !m.is_user)
            .map(m => m.mes)
            .join('\n\n');
    }

    return prompt.replace(/\{\{llmContext\}\}/g, messages);
}

// 통합된 번역 함수 (공식 스크립트 스타일)
async function translate(text, options = {}) {
    try {
        if (!text || text.trim() === '') {
            return '';
        }

        // 기본값 설정
        const {
            prompt = extensionSettings.llm_prompt_chat,
            additionalGuidance = '',
            isInputTranslation = false,
            isRetranslation = false
        } = options;

        // 커스텀 프롬프트 적용 (실시간 텍스트필드 값 사용)
        let finalPrompt = prompt;

        // 채팅 번역 프롬프트인 경우, 텍스트필드의 현재 값을 실시간 반영
        if (prompt === extensionSettings.llm_prompt_chat) {
            const editorElement = document.getElementById('llm_prompt_editor');
            const selectElement = document.getElementById('prompt_select');

            // 텍스트필드의 현재 값을 사용 (저장하지 않아도 번역에 반영됨)
            if (editorElement && selectElement) {
                const selectedValue = selectElement.value;
                const currentEditorValue = editorElement.value;

                // 1. 채팅 번역 프롬프트가 선택되어 있는 경우
                if (selectedValue === 'llm_prompt_chat') {
                    if (currentEditorValue && currentEditorValue.trim() !== '') {
                        finalPrompt = currentEditorValue;
                    }
                }
                // 2. 커스텀 프롬프트가 선택되어 있는 경우
                else if (extensionSettings.selected_translation_prompt_id === selectedValue) {
                    if (currentEditorValue && currentEditorValue.trim() !== '') {
                        finalPrompt = currentEditorValue;
                    }
                }
            }
        }

        // 규칙 프롬프트 처리
        const context = getContext();
        const rulePrompt = !isInputTranslation ? (context?.chatMetadata?.[RULE_PROMPT_KEY] || '') : '';

        let fullPrompt = finalPrompt;
        if (rulePrompt.trim()) {
            fullPrompt = `[Additional Rules]:\n${rulePrompt}\n\n${finalPrompt}`;
        }
        if (additionalGuidance.trim()) {
            fullPrompt += `\n\n[Additional Guidance]:\n${additionalGuidance}`;
        }
        fullPrompt += `\n\n${text}`;

        // 플레이스홀더 치환 (커스텀 먼저, 기본 매크로 다음)
        fullPrompt = substituteCustomPlaceholders(fullPrompt, isInputTranslation);
        fullPrompt = substituteParams(fullPrompt);

        // API 호출
        return await callLLMAPI(fullPrompt);

    } catch (error) {
        console.error('Translation error:', error);
        // API 키 관련 오류인 경우 더 명확한 메시지 제공
        if (error.message.includes('API 키') || error.message.includes('설정되어 있지 않습니다')) {
            throw new Error(`API 키 설정 오류: ${error.message}`);
        }
        // 네트워크 오류
        if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
            throw new Error('네트워크 연결 오류: 인터넷 연결을 확인해주세요.');
        }
        // 일반적인 에러
        throw new Error(`번역 실패: ${error.message}`);
    }
}

// API 호출 로직 (수정됨 - API 키 검증 추가)
async function callLLMAPI(fullPrompt) {
    const provider = extensionSettings.llm_provider;
    // custom 선택 시 실제 커스텀 모델명 사용
    const model = extensionSettings.llm_model === 'custom'
        ? (extensionSettings.custom_model || '')
        : extensionSettings.llm_model;
    const params = extensionSettings.parameters[provider];

    // API 키 검증
    let apiKey;
    let chatCompletionSource;

    switch (provider) {
        case 'openai':
            apiKey = secret_state[SECRET_KEYS.OPENAI];
            chatCompletionSource = 'openai';
            break;
        case 'claude':
            apiKey = secret_state[SECRET_KEYS.CLAUDE];
            chatCompletionSource = 'claude';
            break;
        case 'google':
            apiKey = secret_state[SECRET_KEYS.MAKERSUITE];
            chatCompletionSource = 'makersuite';
            break;
        case 'cohere':
            apiKey = secret_state[SECRET_KEYS.COHERE];
            chatCompletionSource = 'cohere';
            break;
        case 'vertexai':
            apiKey = secret_state[SECRET_KEYS.VERTEXAI] || secret_state[SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT];
            chatCompletionSource = 'vertexai';
            break;
        default:
            throw new Error('지원되지 않는 공급자입니다.');
    }

    if (!apiKey && !extensionSettings.use_reverse_proxy) {
        throw new Error(`${provider.toUpperCase()} API 키가 설정되어 있지 않습니다.`);
    }

    const messages = [{ role: 'user', content: fullPrompt }];

    if (extensionSettings.llm_prefill_toggle) {
        // 프리필도 텍스트필드 값 실시간 반영
        let prefillContent = extensionSettings.llm_prefill_content || 'Understood. Here is my response:';
        const editorElement = document.getElementById('llm_prompt_editor');
        const selectElement = document.getElementById('prompt_select');
        if (editorElement && selectElement && selectElement.value === 'llm_prefill_content') {
            const currentEditorValue = editorElement.value;
            if (currentEditorValue && currentEditorValue.trim() !== '') {
                prefillContent = currentEditorValue;
            }
        }

        const role = (provider === 'google' || provider === 'vertexai') ? 'model' : 'assistant';
        messages.push({ role, content: prefillContent });
    }

    const parameters = {
        model,
        messages,
        temperature: params.temperature,
        stream: false,
        chat_completion_source: chatCompletionSource,
        ...getProviderSpecificParams(provider, params)
    };

    if (params.max_length > 0) {
        parameters.max_tokens = params.max_length;
    }

    if (provider === 'vertexai') {
        parameters.vertexai_auth_mode = 'full';
    }

    if (extensionSettings.use_reverse_proxy) {
        parameters.reverse_proxy = extensionSettings.reverse_proxy_url;
        parameters.proxy_password = extensionSettings.reverse_proxy_password;
    }

    let response;
    try {
        response = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify(parameters)
        });
    } catch (fetchError) {
        // 네트워크 에러 처리
        if (fetchError.name === 'TypeError' && fetchError.message.includes('Failed to fetch')) {
            throw new Error('네트워크 연결에 실패했습니다. 인터넷 연결을 확인해주세요.');
        }
        throw new Error(`요청 실패: ${fetchError.message}`);
    }

    if (!response.ok) {
        let errorMessage = `HTTP ${response.status}`;

        try {
            const errorData = await response.json();
            if (errorData.error && errorData.error.message) {
                errorMessage = errorData.error.message;
            } else if (errorData.message) {
                errorMessage = errorData.message;
            } else {
                errorMessage = response.statusText || errorMessage;
            }
        } catch (e) {
            errorMessage = response.statusText || errorMessage;
        }

        // 상태 코드별 구체적인 메시지
        switch (response.status) {
            case 401:
                throw new Error('API 키가 잘못되었거나 권한이 없습니다.');
            case 403:
                throw new Error('API 접근이 거부되었습니다. API 키 권한을 확인해주세요.');
            case 429:
                throw new Error('API 호출 한도를 초과했습니다. 잠시 후 다시 시도해주세요.');
            case 500:
                throw new Error('서버 내부 오류가 발생했습니다.');
            case 503:
                throw new Error('서비스를 사용할 수 없습니다. 잠시 후 다시 시도해주세요.');
            default:
                throw new Error(errorMessage);
        }
    }

    const data = await response.json();
    return extractTranslationResult(data, provider);
}

// 결과 추출 로직 분리  
function extractTranslationResult(data, provider) {
    let result;
    switch (provider) {
        case 'openai':
            result = data.choices?.[0]?.message?.content?.trim();
            break;
        case 'claude':
            result = data.content?.[0]?.text?.trim();
            break;
        case 'google':
            result = data.candidates?.[0]?.content?.trim() ||
                data.choices?.[0]?.message?.content?.trim() ||
                data.text?.trim();
            break;
        case 'cohere':
            result = data.message?.content?.[0]?.text?.trim() ||
                data.generations?.[0]?.text?.trim() ||
                data.text?.trim() ||
                data.choices?.[0]?.message?.content?.trim() ||
                data.content?.[0]?.text?.trim();
            break;
        case 'vertexai':
            result = data.candidates?.[0]?.content?.trim() ||
                data.choices?.[0]?.message?.content?.trim() ||
                data.text?.trim();
            break;
    }

    if (!result) {
        throw new Error(`번역 응답이 비어있습니다. ${provider.toUpperCase()} API에서 올바른 응답을 받지 못했습니다.`);
    }
    return result;
}

// 재번역 함수 (교정 또는 문단 맞추기)
async function retranslateMessage(messageId, promptType, forceRetranslate = false) {
    const context = getContext();
    const message = context.chat[messageId];

    if (!message) return;

    if (typeof message.extra !== 'object') {
        message.extra = {};
    }

    // 이미 번역 중인 경우
    if (translationInProgress[messageId]) {
        toastr.info('번역이 이미 진행 중입니다.');
        return;
    }

    // promptType 검증
    const validPromptTypes = ['correction', 'guidance', 'paragraph'];
    if (!validPromptTypes.includes(promptType)) {
        toastr.error('유효하지 않은 재번역 타입입니다.');
        return;
    }

    const promptTypeKorean = promptType === 'correction' ? '교정' : promptType === 'guidance' ? '지침교정' : '문단 수 맞추기';

    // guidance 타입의 경우 추가 지침 입력받기
    let additionalGuidance = '';
    if (promptType === 'guidance') {
        additionalGuidance = await callGenericPopup(
            '추가 지침을 입력하세요:',
            POPUP_TYPE.INPUT,
            '',
            { wide: false, large: false }
        );

        if (additionalGuidance === false || additionalGuidance === null) {
            toastr.info('지침교정이 취소되었습니다.');
            return;
        }

        if (!additionalGuidance.trim()) {
            toastr.warning('추가 지침이 입력되지 않았습니다. 일반 교정으로 진행합니다.');
            promptType = 'correction';
        }
    }

    toastr.info(`재번역(${promptTypeKorean})을 시작합니다 #${messageId}`);
    translationInProgress[messageId] = true;

    try {
        const originalText = substituteParams(message.mes, context.name1, message.name);
        const existingTranslation = await getTranslationFromDB(originalText);

        let textToRetranslate, prompt;

        if (existingTranslation) {
            // 기존 번역이 있는 경우 - 재번역 수행
            textToRetranslate = `[Original Text]:\n${originalText}\n\n[Translated Text]:\n${existingTranslation}`;
            const promptMap = {
                'correction': 'llm_prompt_retranslate_correction',
                'guidance': 'llm_prompt_retranslate_guidance',
                'paragraph': 'llm_prompt_retranslate_paragraph'
            };
            const promptKey = promptMap[promptType];

            // 텍스트필드의 현재 값을 실시간 반영
            const editorElement = document.getElementById('llm_prompt_editor');
            const selectElement = document.getElementById('prompt_select');
            if (editorElement && selectElement && selectElement.value === promptKey) {
                const currentEditorValue = editorElement.value;
                prompt = (currentEditorValue && currentEditorValue.trim() !== '')
                    ? currentEditorValue
                    : extensionSettings[promptKey];
            } else {
                prompt = extensionSettings[promptKey];
            }
        } else {
            // 기존 번역이 없는 경우 - 새 번역 수행
            toastr.warning(`기존 번역문이 없습니다. 새로 번역합니다.`);
            textToRetranslate = originalText;

            // 채팅 번역 프롬프트도 텍스트필드 값 실시간 반영
            const editorElement = document.getElementById('llm_prompt_editor');
            const selectElement = document.getElementById('prompt_select');
            if (editorElement && selectElement && selectElement.value === 'llm_prompt_chat') {
                const currentEditorValue = editorElement.value;
                prompt = (currentEditorValue && currentEditorValue.trim() !== '')
                    ? currentEditorValue
                    : extensionSettings.llm_prompt_chat;
            } else {
                prompt = extensionSettings.llm_prompt_chat;
            }
        }

        const options = {
            prompt,
            additionalGuidance: promptType === 'guidance' ? additionalGuidance : '',
            isRetranslation: true
        };

        const retranslation = await translate(textToRetranslate, options);

        // 결과 저장 및 UI 업데이트
        await deleteTranslationByOriginalText(originalText);
        await addTranslationToDB(originalText, retranslation);
        message.extra.display_text = processTranslationText(originalText, retranslation);
        // 현재 원문을 저장 (메시지 수정 시 이전 원문의 번역을 삭제하기 위해)
        message.extra.original_text_for_translation = originalText;

        // 원문 표시 백업 초기화 (재번역했으므로)
        delete message.extra.original_translation_backup;

        updateMessageBlock(messageId, message);

        // 번역문 표시 플래그 설정 (Font Manager 등 다른 확장과의 호환성을 위해)
        // updateMessageBlock 후 DOM이 완전히 업데이트된 후 플래그 설정
        setTimeout(() => {
            const messageBlock = $(`#chat .mes[mesid="${messageId}"]`);
            const textBlock = messageBlock.find('.mes_text');
            textBlock.data('showing-original', false);
        }, 100);

        await context.saveChat();

        toastr.success(`재번역(${promptTypeKorean}) 완료 #${messageId}`);

    } catch (error) {
        console.error('Retranslation error:', error);

        // 구체적인 에러 메시지 표시
        let errorMessage = '재번역에 실패했습니다.';
        if (error.message) {
            errorMessage = error.message;
        }

        toastr.error(`메시지 #${messageId} ${errorMessage}`, `재번역(${promptTypeKorean}) 실패`, { timeOut: 10000 });
    } finally {
        translationInProgress[messageId] = false;
    }
}

// 단순화된 메시지 번역 함수
async function translateMessage(messageId, forceTranslate = false, source = 'manual') {
    const context = getContext();
    const message = context.chat[messageId];

    if (!message) {
        return;
    }

    if (typeof message.extra !== 'object') {
        message.extra = {};
    }

    // 번역 진행 중 확인
    if (translationInProgress[messageId]) {
        if (source === 'manual') {
            toastr.info('번역이 이미 진행 중입니다.');
        }
        return;
    }

    translationInProgress[messageId] = true;

    try {
        const originalText = substituteParams(message.mes, context.name1, message.name);

        // 번역 시작 알림 (조건부)
        // 1. 모든 수동 번역시 표시
        // 2. 자동 번역시: DB에 번역문이 없는 새로운 메시지만 표시 (스와이프 기존 번역 제외)
        let showStartToast = false;
        if (source === 'manual' ||
            source === 'handleTranslateButtonClick' ||
            source === 'handleTranslateButtonClick_retranslate') {
            showStartToast = true;
        } else if (source === 'auto' && !message.extra.display_text) {
            // 자동 번역시: DB에서 번역문을 가져올 수 있는지 먼저 확인
            const existingTranslation = await getTranslationFromDB(originalText);

            // DB에 번역문이 없는 경우만 토스트 표시 (새로운 메시지)
            if (!existingTranslation) {
                showStartToast = true;
            }
        }

        if (showStartToast) {
            toastr.info(`번역을 시작합니다 #${messageId}`);
        }

        // 강제 번역이거나 번역문이 없는 경우, 또는 자동 번역시 원문이 바뀐 경우
        let shouldTranslate = forceTranslate || !message.extra.display_text;

        // 자동 번역시 원문이 바뀌었는지 확인
        if (!shouldTranslate && source === 'auto' && message.extra.display_text) {
            // DB에서 현재 원문에 대한 번역이 있는지 확인
            const cachedForCurrentText = await getTranslationFromDB(originalText);
            if (!cachedForCurrentText) {
                shouldTranslate = true;
            }
        }

        if (shouldTranslate) {
            // 캐시된 번역 확인
            const cachedTranslation = await getTranslationFromDB(originalText);

            if (cachedTranslation) {
                message.extra.display_text = processTranslationText(originalText, cachedTranslation);
                // 현재 원문을 저장 (메시지 수정 시 이전 원문의 번역을 삭제하기 위해)
                message.extra.original_text_for_translation = originalText;
                if (source !== 'auto') {
                    toastr.info('IndexedDB에서 번역문을 가져왔습니다.');
                }
            } else {
                // 새로 번역
                const translation = await translate(originalText);
                await addTranslationToDB(originalText, translation);
                message.extra.display_text = processTranslationText(originalText, translation);
            }

            // 현재 원문을 저장 (메시지 수정 시 이전 원문의 번역을 삭제하기 위해)
            message.extra.original_text_for_translation = originalText;

            // 원문 표시 백업 초기화 (새로 번역했으므로)
            delete message.extra.original_translation_backup;

            updateMessageBlock(messageId, message);

            // 번역문 표시 플래그 설정 (Font Manager 등 다른 확장과의 호환성을 위해)
            // updateMessageBlock 후 DOM이 완전히 업데이트된 후 플래그 설정
            setTimeout(() => {
                const messageBlock = $(`#chat .mes[mesid="${messageId}"]`);
                const textBlock = messageBlock.find('.mes_text');
                textBlock.data('showing-original', false);
            }, 100);

            await context.saveChat();
        }
    } catch (error) {
        console.error('Translation error:', error);

        // 구체적인 에러 메시지 표시
        let errorMessage = '번역에 실패했습니다.';
        if (error.message) {
            errorMessage = error.message;
        }

        toastr.error(`메시지 #${messageId} ${errorMessage}`, '번역 실패', { timeOut: 10000 });
    } finally {
        translationInProgress[messageId] = false;
    }
}

// 원문과 번역문 토글
async function toggleOriginalText(messageId) {
    const context = getContext();
    const message = context.chat[messageId];
    if (!message?.extra?.display_text) return;

    const messageBlock = $(`#chat .mes[mesid="${messageId}"]`);
    const textBlock = messageBlock.find('.mes_text');
    const isCurrentlyShowingOriginal = textBlock.data('showing-original');

    if (isCurrentlyShowingOriginal) {
        // 원문 표시 중 → 번역문으로 전환
        if (message.extra.original_translation_backup) {
            message.extra.display_text = message.extra.original_translation_backup;
            delete message.extra.original_translation_backup;
        }
    } else {
        // 번역문 표시 중 → 원문으로 전환
        if (!message.extra.original_translation_backup) {
            message.extra.original_translation_backup = message.extra.display_text;
        }
        const originalText = substituteParams(message.mes, context.name1, message.name);
        message.extra.display_text = originalText;
    }

    await updateMessageBlock(messageId, message);

    // updateMessageBlock 후 DOM이 완전히 업데이트된 후 플래그 설정
    setTimeout(() => {
        const messageBlock = $(`#chat .mes[mesid="${messageId}"]`);
        const textBlock = messageBlock.find('.mes_text');
        textBlock.data('showing-original', !isCurrentlyShowingOriginal);
    }, 100);
}

// 현재 화면에 번역문이 표시되고 있는지 확인하는 함수
function isTranslationCurrentlyDisplayed(messageId) {
    const context = getContext();
    const message = context.chat[messageId];

    // 번역문이 없으면 false
    if (!message?.extra?.display_text) {
        return false;
    }

    const messageBlock = $(`#chat .mes[mesid="${messageId}"]`);
    const textBlock = messageBlock.find('.mes_text');
    const showingOriginalFlag = textBlock.data('showing-original');

    // showing-original 플래그가 명시적으로 true이면 원문 표시 중
    if (showingOriginalFlag === true) {
        return false;
    }

    // showing-original 플래그가 명시적으로 false이면 번역문 표시 중  
    if (showingOriginalFlag === false) {
        return true;
    }

    // showing-original 플래그가 설정되지 않은 경우 (초기 번역 후 상태)
    // 현재 화면에 표시된 텍스트와 원본 메시지 텍스트를 비교
    const originalText = substituteParams(message.mes, context.name1, message.name);
    const currentDisplayedHtml = textBlock.html();

    // HTML에서 텍스트만 추출하여 비교
    // Font Manager 등 다른 확장이 추가한 태그를 제거하여 정확한 비교
    const tempDiv = $('<div>').html(currentDisplayedHtml);

    // Font Manager가 추가한 커스텀 태그 폰트 span 제거
    tempDiv.find('[data-custom-tag-font]').each(function () {
        $(this).replaceWith($(this).html());
    });

    const currentDisplayedText = tempDiv.text().trim();
    const originalTextTrimmed = originalText.trim();

    // 현재 표시된 텍스트가 원본과 같으면 원문 표시 중, 다르면 번역문 표시 중
    return currentDisplayedText !== originalTextTrimmed;
}

// messageId 유효성 검사 및 기본값 처리 함수
function validateAndNormalizeMessageId(messageIdStr) {
    // 기본값 처리
    if (!messageIdStr) {
        return 'last';
    }

    // 'last'는 유효한 값으로 처리
    if (messageIdStr === 'last') {
        return 'last';
    }

    // 숫자로 변환 시도
    const messageId = parseInt(messageIdStr, 10);

    // 숫자가 아니거나 음수면 기본값 사용
    if (isNaN(messageId) || messageId < 0) {
        return 'last';
    }

    // 채팅 범위 확인
    const context = getContext();
    if (!context || !context.chat || context.chat.length === 0) {
        return 'last';
    }

    // 범위를 벗어나면 기본값 사용
    if (messageId >= context.chat.length) {
        return 'last';
    }

    // 유효한 숫자면 문자열로 반환
    return String(messageId);
}

// 아이콘 표시/숨김 업데이트 함수
function updateButtonVisibility() {
    $('.mes_legacy_translate').toggle(!extensionSettings.hide_legacy_translate_button);
    $('.mes_llm_translate').toggle(!extensionSettings.hide_new_translate_button);
    $('.mes_toggle_original').toggle(!extensionSettings.hide_toggle_button);
    $('.mes_paragraph_correction').toggle(!extensionSettings.hide_paragraph_button);
    $('.mes_edit_translation').toggle(!extensionSettings.hide_edit_button);
    $('.mes_delete_translation').toggle(!extensionSettings.hide_delete_button);
}

// 번역문이 표시되고 있을 때 원문으로 전환하는 함수
async function showOriginalText(messageId) {
    const context = getContext();
    const message = context.chat[messageId];
    if (!message?.extra?.display_text) return;

    // 번역문을 백업 (나중에 복원하기 위해)
    if (!message.extra.original_translation_backup) {
        message.extra.original_translation_backup = message.extra.display_text;
    }

    // 원문으로 전환
    const originalText = substituteParams(message.mes, context.name1, message.name);
    message.extra.display_text = originalText;

    await updateMessageBlock(messageId, message);

    // updateMessageBlock 후 DOM이 완전히 업데이트된 후 플래그 설정
    setTimeout(() => {
        const messageBlock = $(`#chat .mes[mesid="${messageId}"]`);
        const textBlock = messageBlock.find('.mes_text');
        textBlock.data('showing-original', true);
    }, 100);
}

// 번역 버튼 클릭 시 상태에 따른 동작 처리
async function handleTranslateButtonClick(messageId) {
    const context = getContext();
    const message = context.chat[messageId];

    // 번역 진행 중 확인
    if (translationInProgress[messageId]) {
        toastr.info('번역이 이미 진행 중입니다.');
        return;
    }

    // 번역문이 없는 경우 → 번역 실행
    if (!message?.extra?.display_text) {
        await translateMessage(messageId, true, 'handleTranslateButtonClick');
        return;
    }

    // 현재 번역문이 표시되고 있는지 확인
    const isShowingTranslation = isTranslationCurrentlyDisplayed(messageId);

    if (isShowingTranslation) {
        // 번역문이 표시되고 있는 경우 → 원문 표시
        await showOriginalText(messageId);
        toastr.info(`원문으로 전환했습니다 #${messageId}`);
    } else {
        // 원문이 표시되고 있는 경우 → 백업된 번역문 복원

        // 백업된 번역문이 있으면 복원
        if (message.extra.original_translation_backup) {
            message.extra.display_text = message.extra.original_translation_backup;
            delete message.extra.original_translation_backup;

            await updateMessageBlock(messageId, message);

            // 번역문 표시 플래그 설정
            setTimeout(() => {
                const messageBlock = $(`#chat .mes[mesid="${messageId}"]`);
                const textBlock = messageBlock.find('.mes_text');
                textBlock.data('showing-original', false);
            }, 100);

            toastr.info(`번역문으로 전환했습니다 #${messageId}`);
        } else {
            // 백업이 없으면 재번역
            const messageBlock = $(`#chat .mes[mesid="${messageId}"]`);
            const textBlock = messageBlock.find('.mes_text');
            textBlock.data('showing-original', false);

            await translateMessage(messageId, true, 'handleTranslateButtonClick_retranslate');
        }
    }
}

// 전체 채팅 번역 (단순화)
async function onTranslateChatClick() {
    if (isChatTranslationInProgress) {
        isChatTranslationInProgress = false;
        toastr.info('채팅 번역을 중단합니다.');
        return;
    }

    const context = getContext();
    const chat = context.chat;

    if (!chat || chat.length === 0) {
        toastr.warning('번역할 채팅이 없습니다.');
        return;
    }

    const confirm = await callGenericPopup('전체 채팅을 번역하시겠습니까?', POPUP_TYPE.CONFIRM);
    if (!confirm) return;

    isChatTranslationInProgress = true;
    const translateButton = $('#llm_translate_chat');

    // 버튼 상태 변경
    translateButton.find('.fa-right-left').removeClass('fa-right-left').addClass('fa-stop-circle');
    translateButton.find('span').text('번역 중단');
    translateButton.addClass('translating');

    toastr.info(`채팅 번역을 시작합니다. (${chat.length}개 메시지)`);

    try {
        const throttleDelay = parseInt(extensionSettings.throttle_delay) || 0;

        for (let i = 0; i < chat.length && isChatTranslationInProgress; i++) {
            await translateMessage(i, false, 'batch');

            if (throttleDelay > 0) {
                await new Promise(resolve => setTimeout(resolve, throttleDelay));
            }
        }

        if (isChatTranslationInProgress) {
            await context.saveChat();
            toastr.success('채팅 번역이 완료되었습니다.');
        }
    } catch (error) {
        console.error('Chat translation error:', error);

        // 구체적인 에러 메시지 표시
        let errorMessage = '채팅 번역에 실패했습니다.';
        if (error.message) {
            errorMessage = error.message;
        }

        toastr.error(errorMessage, '채팅 번역 실패', { timeOut: 10000 });
    } finally {
        isChatTranslationInProgress = false;

        // 버튼 복원
        translateButton.find('.fa-stop-circle').removeClass('fa-stop-circle').addClass('fa-right-left');
        translateButton.find('span').text('LLM으로 전체 번역');
        translateButton.removeClass('translating');
    }
}

// 입력창 번역 (단순화)
async function onTranslateInputMessageClick() {
    const textarea = document.getElementById('send_textarea');

    if (!(textarea instanceof HTMLTextAreaElement) || !textarea.value) {
        toastr.warning('먼저 메시지를 입력하세요.');
        return;
    }

    try {
        // 입력 번역 프롬프트도 텍스트필드 값 실시간 반영
        let inputPrompt = extensionSettings.llm_prompt_input;
        const editorElement = document.getElementById('llm_prompt_editor');
        const selectElement = document.getElementById('prompt_select');
        if (editorElement && selectElement && selectElement.value === 'llm_prompt_input') {
            const currentEditorValue = editorElement.value;
            if (currentEditorValue && currentEditorValue.trim() !== '') {
                inputPrompt = currentEditorValue;
            }
        }

        const options = {
            prompt: inputPrompt,
            isInputTranslation: true
        };
        const translatedText = await translate(textarea.value, options);
        textarea.value = translatedText;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (error) {
        console.error('Input translation error:', error);

        // 구체적인 에러 메시지 표시
        let errorMessage = '입력 번역에 실패했습니다.';
        if (error.message) {
            errorMessage = error.message;
        }

        toastr.error(errorMessage, '입력 번역 실패', { timeOut: 10000 });
    }
}

// 모든 번역문 삭제
async function onTranslationsClearClick() {
    const confirm = await callGenericPopup(
        '번역된 내용을 모두 삭제하시겠습니까?',
        POPUP_TYPE.CONFIRM
    );

    if (!confirm) {
        return;
    }

    const context = getContext();
    const chat = context.chat;

    for (const mes of chat) {
        if (mes.extra) {
            delete mes.extra.display_text;
        }
    }

    await context.saveChat();
    await reloadCurrentChat();
    toastr.success('번역된 내용이 삭제되었습니다.');
}

// 메세지 블록에 번역 버튼 생성
const createTranslateButtons = (mesBlock) => {
    const messageId = mesBlock.attr('mesid');
    const extraMesButtons = mesBlock.find('.extraMesButtons');

    // 아이콘이 이미 추가되어 있는지 확인
    if (mesBlock.find('.mes_llm_translate').length > 0) {
        return;
    }

    // 1. 기존 번역 아이콘 (뇌) - 순수 번역 기능
    const legacyTranslateButton = $('<div>')
        .addClass('mes_button mes_legacy_translate fa-solid fa-brain interactable')
        .attr({
            'title': 'LLM 번역 (기존)',
            'data-i18n': '[title]LLM 번역 (기존)',
            'tabindex': '0'
        });

    // 2. 새로운 번역/전환 아이콘 (좌우 화살표) - 토글 기능
    const newTranslateButton = $('<div>')
        .addClass('mes_button mes_llm_translate fa-solid fa-right-left interactable')
        .attr({
            'title': 'LLM 번역/전환',
            'data-i18n': '[title]LLM 번역/전환',
            'tabindex': '0'
        });

    // 3. 번역 전환 아이콘 (돋보기)
    const toggleButton = $('<div>')
        .addClass('mes_button mes_toggle_original fa-solid fa-magnifying-glass interactable')
        .attr({
            'title': '원문/번역 전환',
            'data-i18n': '[title]원문/번역 전환',
            'tabindex': '0'
        });

    // 4. 편집 아이콘
    const editButton = $('<div>')
        .addClass('mes_button mes_edit_translation fa-solid fa-pen-to-square interactable')
        .attr({
            'title': '번역문 수정',
            'data-i18n': '[title]번역문 수정',
            'tabindex': '0'
        });

    // 5. 문단 수 교정 아이콘 (렌치)
    const paragraphButton = $('<div>')
        .addClass('mes_button mes_paragraph_correction fa-solid fa-wrench interactable')
        .attr({
            'title': '문단 수 교정',
            'data-i18n': '[title]문단 수 교정',
            'tabindex': '0'
        });

    // 6. 번역 삭제 아이콘 (쓰레기통)
    const deleteButton = $('<div>')
        .addClass('mes_button mes_delete_translation fa-solid fa-trash interactable')
        .attr({
            'title': '번역문 삭제',
            'data-i18n': '[title]번역문 삭제',
            'tabindex': '0'
        });

    // 설정에 따라 아이콘 표시/숨김
    if (extensionSettings.hide_legacy_translate_button) {
        legacyTranslateButton.hide();
    }
    if (extensionSettings.hide_new_translate_button) {
        newTranslateButton.hide();
    }
    if (extensionSettings.hide_toggle_button) {
        toggleButton.hide();
    }
    if (extensionSettings.hide_paragraph_button) {
        paragraphButton.hide();
    }
    if (extensionSettings.hide_edit_button) {
        editButton.hide();
    }
    if (extensionSettings.hide_delete_button) {
        deleteButton.hide();
    }

    // 버튼들을 메시지에 추가
    extraMesButtons.prepend(deleteButton);
    extraMesButtons.prepend(paragraphButton);
    extraMesButtons.prepend(editButton);
    extraMesButtons.prepend(toggleButton);
    extraMesButtons.prepend(newTranslateButton);
    extraMesButtons.prepend(legacyTranslateButton);
};

// 기존 메시지에 아이콘 추가
function addButtonsToExistingMessages() {
    $('#chat .mes').each(function () {
        const $this = $(this);
        if (!$this.find('.mes_llm_translate').length) {
            createTranslateButtons($this);
        }
    });
}

// 번역문 수정
// 번역문 수정
async function editTranslation(messageId) {
    const context = getContext();
    const message = context.chat[messageId];

    // 0. 메시지 객체 및 display_text 유효성 검사 (기존과 동일)
    if (!message?.extra?.display_text) {
        toastr.warning('수정할 번역문이 없습니다.');
        return;
    }

    const mesBlock = $(`.mes[mesid="${messageId}"]`);
    const mesText = mesBlock.find('.mes_text');

    // ★★★★★ 1. DB에서 원본(가공 전) 번역문 가져오기 ★★★★★
    const originalMessageText = substituteParams(message.mes, context.name1, message.name);
    let originalDbTranslation;
    try {
        originalDbTranslation = await getTranslationFromDB(originalMessageText);
        // DB에 해당 원본 메시지에 대한 번역이 없는 극히 예외적인 경우 처리
        if (originalDbTranslation === null) {
            toastr.error('오류: 화면에는 번역문이 있으나 DB에서 원본을 찾을 수 없습니다.');
            return;
        }
    } catch (error) {
        console.error("편집용 원본 번역문 DB 조회 실패:", error); // 오류 로깅 유지
        toastr.error("편집을 위해 원본 번역문을 가져오는 데 실패했습니다.");
        return;
    }
    // 편집 모드로 전환
    mesBlock.addClass('translation-editing');
    mesBlock.find('.mes_buttons').hide();

    // Textarea를 원본 번역문으로 초기화
    const editTextarea = $('<textarea>')
        .addClass('edit_textarea translation_edit_textarea')
        .val(originalDbTranslation);

    // 완료 및 취소 버튼 생성
    const editButtons = $('<div>').addClass('translation_edit_buttons');
    const saveButton = $('<div>')
        .addClass('translation_edit_done interactable fa-solid fa-check-circle')
        .attr('title', '저장');
    const cancelButton = $('<div>')
        .addClass('translation_edit_cancel interactable fa-solid fa-times-circle')
        .attr('title', '취소');
    editButtons.append(saveButton, cancelButton);

    // UI 요소 배치 (기존과 동일)
    mesText.hide();
    mesText.after(editTextarea);
    editTextarea.before(editButtons);

    // 이벤트 핸들러
    cancelButton.on('click', function () {
        // ★★★★★ 3. 편집 취소: 변경 없음, 원래 상태로 복귀 ★★★★★
        // Textarea와 버튼 제거, 원래 mesText (가공된 텍스트 포함) 표시
        editTextarea.remove();
        editButtons.remove();
        mesText.show();
        mesBlock.removeClass('translation-editing');
        mesBlock.find('.mes_buttons').show();
        // 따로 가공 처리할 필요 없음. message.extra.display_text는 변경되지 않았음.
    });

    saveButton.on('click', async function () {
        // 편집 내용 저장
        const newText = editTextarea.val();

        // 원본 메시지 텍스트 다시 가져오기 (DB 키로 사용)
        const originalTextForDbKey = substituteParams(message.mes, context.name1, message.name);

        // 삭제 로직
        if (newText.trim() === "") {
            try {
                await deleteTranslationByOriginalText(originalTextForDbKey);
                message.extra.display_text = null;
                await updateMessageBlock(messageId, message);
                await context.saveChat();
                toastr.success('번역문이 삭제되었습니다.');
            } catch (e) {
                toastr.error('번역문 삭제(DB)에 실패했습니다.');
                console.error(e);
            }
        }
        // 변경 여부 확인
        else if (newText !== originalDbTranslation) {
            try {
                // DB 업데이트
                await updateTranslationByOriginalText(originalTextForDbKey, newText);

                // 화면 표시용 HTML 생성
                const processedNewText = processTranslationText(originalTextForDbKey, newText);

                // 메시지 객체 업데이트
                message.extra.display_text = processedNewText;

                // UI 업데이트 및 채팅 저장
                await updateMessageBlock(messageId, message);
                await context.saveChat();

                toastr.success('번역문이 수정되었습니다.');

            } catch (e) {
                toastr.error('번역문 수정 중 오류가 발생했습니다.');
                console.error('번역문 수정 오류:', e);
            }
        } else {
            // 변경 사항이 없을 경우
            toastr.info('번역 내용이 변경되지 않았습니다.');
        }

        // 편집 종료 (성공/실패/변경없음 모두 공통)
        editTextarea.remove();
        editButtons.remove();
        mesText.show();
        mesBlock.removeClass('translation-editing');
        mesBlock.find('.mes_buttons').show();
    });

    // 텍스트 영역 포커스 (기존과 동일)
    editTextarea.focus();
}

// 입력 번역 버튼
function updateInputTranslateButton() {
    if (extensionSettings.show_input_translate_button) {
        if ($('#llm_translate_input_button').length === 0) {
            // sendform.html 로드
            $.get(`${extensionFolderPath}/sendform.html`, function (data) {
                $('#rightSendForm').append(data);
                $('#llm_translate_input_button').off('click').on('click', onTranslateInputMessageClick);
            });
        }
    } else {
        $('#llm_translate_input_button').remove();
    }
}



// jQuery 초기화 블록
jQuery(async () => {
    try {
        // 필요한 HTML과 CSS 로드
        const timestamp = Date.now();
        const html = await $.get(`${extensionFolderPath}/index.html?v=${timestamp}`);
        const buttonHtml = await $.get(`${extensionFolderPath}/buttons.html?v=${timestamp}`);

        $('#translate_wand_container').append(buttonHtml);
        $('#translation_container').append(html);

        const cssLink = $('<link>', {
            rel: 'stylesheet',
            type: 'text/css',
            href: `${extensionFolderPath}/style.css?v=${timestamp}`
        });
        $('head').append(cssLink);

        // html 완전 로드 후 설정 불러오기
        await new Promise(resolve => setTimeout(resolve, 100));

        // 프롬프트 매니저 초기화
        promptManager = new PromptManager();
        presetManager = new PresetManager();

        // 설정 로드 (프롬프트 매니저 초기화 후)
        loadSettings();
        initializeEventHandlers();

        // 프리셋 드롭다운 업데이트
        if (presetManager) {
            presetManager.updatePresetDropdown();
        }

        logDebug('LLM Translator extension initialized successfully');
    } catch (error) {
        console.error('Error initializing LLM Translator extension:', error);
    }
});

// ===== SillyTavern 기본 번역 로직 채택 =====

/**
 * 스와이프 생성 중인지 확인하는 함수 (SillyTavern 기본 번역과 동일)
 * @param {string|number} messageId Message ID
 * @returns {boolean} Whether the swipe is being generated
 */
function isGeneratingSwipe(messageId) {
    return $(`#chat .mes[mesid="${messageId}"] .mes_text`).text() === '...';
}

/**
 * 자동 번역을 실행해야 하는지 확인하는 함수 (SillyTavern 기본 번역과 동일)
 * @returns {boolean} Whether to translate automatically
 */
function shouldTranslate() {
    return extensionSettings.auto_translate_new_messages;
}

/**
 * 이벤트 핸들러 생성 함수 (SillyTavern 기본 번역과 동일)
 * @param {Function} translateFunction 번역 함수
 * @param {Function} shouldTranslateFunction 번역 여부 확인 함수
 * @returns {Function} Event handler function
 */
function createEventHandler(translateFunction, shouldTranslateFunction) {
    return (data) => {
        if (shouldTranslateFunction()) {
            translateFunction(data);
        }
    };
}

// 자동 번역 함수들 (공식 스크립트 스타일)
function translateIncomingMessage(messageId) {
    const context = getContext();
    const message = context.chat[messageId];

    if (!message || isGeneratingSwipe(messageId)) {
        return;
    }

    if (typeof message.extra !== 'object') {
        message.extra = {};
    }

    // 백그라운드에서 번역 실행
    translateMessage(messageId, false, 'auto').catch(error => {
        console.warn('Auto translation failed:', error);
    });
}

function translateOutgoingMessage(messageId) {
    const context = getContext();
    const message = context.chat[messageId];

    if (!message) {
        return;
    }

    if (typeof message.extra !== 'object') {
        message.extra = {};
    }

    // 백그라운드에서 번역 실행
    translateMessage(messageId, false, 'auto').catch(error => {
        console.warn('Auto translation failed:', error);
    });
}

// 이벤트 핸들러들 (SillyTavern 스타일)
const handleIncomingMessage = createEventHandler(translateIncomingMessage, shouldTranslate);
const handleOutgoingMessage = createEventHandler(translateOutgoingMessage, shouldTranslate);

// 메시지 수정 시 번역문 정리 (공식 스크립트 스타일)
async function handleMessageEdit(messageId) {
    const context = getContext();
    const message = context.chat[messageId];

    if (!message) return;

    // 메시지 수정시 기존 번역문 초기화
    if (message.extra?.display_text) {
        // 현재 메시지의 원문 가져오기 (수정 후 원문)
        const currentOriginalText = substituteParams(message.mes, context.name1, message.name);

        // 저장된 이전 원문과 비교하여 실제로 수정되었는지 확인
        const previousOriginalText = message.extra.original_text_for_translation;

        if (previousOriginalText && previousOriginalText !== currentOriginalText) {
            // 실제로 원문이 변경된 경우에만 이전 원문의 번역 삭제
            try {
                await deleteTranslationByOriginalText(previousOriginalText);
                logDebug(`Message ${messageId} was actually edited. Deleted translation for previous original text: "${previousOriginalText.substring(0, 50)}..."`);
            } catch (error) {
                // DB에 해당 번역이 없을 수도 있음 (이미 삭제되었거나 없는 경우)
                if (error.message !== 'no matching data') {
                    console.warn(`Failed to delete translation for previous original text:`, error);
                }
            }

            // display_text 삭제 (실제로 수정된 경우에만)
            delete message.extra.display_text;

            // 현재 원문을 저장 (나중에 또 수정될 수 있으므로)
            message.extra.original_text_for_translation = currentOriginalText;

            // UI도 즉시 업데이트
            updateMessageBlock(messageId, message);

            // 자동 번역이 켜져있으면 새로 번역
            if (shouldTranslate()) {
                setTimeout(() => {
                    translateIncomingMessage(messageId);
                }, 100); // 약간의 지연을 두어 UI 업데이트 후 번역
            }
        } else if (previousOriginalText && previousOriginalText === currentOriginalText) {
            // 수정 버튼을 눌렀지만 실제로는 수정하지 않은 경우
            // 아무것도 하지 않음 (번역 데이터 유지)
            logDebug(`Message ${messageId} edit button was clicked but no actual changes were made. Keeping translation data.`);
        } else {
            // previousOriginalText가 없는 경우 (번역이 있었지만 원문 추적이 안 된 경우)
            // 기존 동작 유지
            delete message.extra.display_text;
            updateMessageBlock(messageId, message);

            if (shouldTranslate()) {
                setTimeout(() => {
                    translateIncomingMessage(messageId);
                }, 100);
            }
        }
    }
}

// 이벤트 핸들러 등록 함수
function initializeEventHandlers() {




    // 새로운 클릭 리스너 추가 (SillyTavern 방식 적용)
    $(document).off('click', '.prompt-editor-button').on('click', '.prompt-editor-button', async function () {
        // 1. data-for 속성에서 원본 textarea ID 가져오기
        const originalTextareaId = $(this).data('for'); // 'llm_prompt_chat', 'llm_prompt_input' 등
        const originalTextarea = $(`#${originalTextareaId}`); // jQuery 객체

        // 원본 textarea를 찾았는지 확인
        if (!originalTextarea.length) {
            console.error(`[LLM Translator] Could not find original textarea with id: ${originalTextareaId}`);
            toastr.error('편집할 원본 텍스트 영역을 찾을 수 없습니다.');
            return;
        }

        // 2. callGenericPopup에 전달할 요소들 동적 생성
        const wrapper = document.createElement('div');
        // SillyTavern과 유사한 스타일링 적용 (필요시 클래스 추가)
        wrapper.classList.add('height100p', 'wide100p', 'flex-container', 'flexFlowColumn');

        const popupTextarea = document.createElement('textarea');
        popupTextarea.dataset.for = originalTextareaId; // 참조용으로 추가 (선택 사항)
        popupTextarea.value = originalTextarea.val(); // 원본 내용 복사
        // SillyTavern과 유사한 스타일링 적용 + LLM Translator 필요 스타일
        popupTextarea.classList.add('height100p', 'wide100p'); // 기본 크기
        // popupTextarea.classList.add('maximized_textarea'); // ST 클래스 (필요 여부 확인)
        // 원본에 monospace 클래스가 있다면 복사 (LLM Translator에 해당 클래스가 있다면)
        // if (originalTextarea.hasClass('monospace')) { popupTextarea.classList.add('monospace'); }

        // 3. 새 textarea 변경 시 원본 textarea 실시간 업데이트
        popupTextarea.addEventListener('input', function () {
            // 원본 textarea 값 변경 및 input 이벤트 트리거 (SillyTavern 방식)
            originalTextarea.val(popupTextarea.value).trigger('input');
            // LLM Translator의 설정 저장 로직도 트리거해야 할 수 있음 (확인 필요)
            // 예: saveSettingsDebounced(); 또는 해당 설정 값 직접 업데이트
            if (originalTextareaId === 'llm_prompt_editor') {
                // 통합 프롬프트 편집기의 경우 현재 선택된 프롬프트에 저장
                const selectorElement = $('#prompt_select');
                if (selectorElement.length > 0) {
                    const selectedPromptKey = selectorElement.val();
                    if (selectedPromptKey) {
                        // 커스텀 프롬프트 확인
                        const customPrompt = promptManager.customPrompts.find(p => p.id === selectedPromptKey);
                        if (customPrompt) {
                            customPrompt.content = popupTextarea.value;
                            promptManager.saveToLocalStorage();
                        } else {
                            // 기본 프롬프트
                            extensionSettings[selectedPromptKey] = popupTextarea.value;
                            $(`#${selectedPromptKey}`).val(popupTextarea.value);
                        }
                    }
                }
            }
            saveSettingsDebounced(); // 디바운스 저장 호출
        });

        wrapper.appendChild(popupTextarea);

        // 4. SillyTavern의 callGenericPopup 호출!
        try {
            // POPUP_TYPE.TEXT 는 SillyTavern 전역 스코프에 정의되어 있어야 함
            if (typeof callGenericPopup === 'function' && typeof POPUP_TYPE !== 'undefined' && POPUP_TYPE.TEXT) {
                // 제목 가져오기 (선택 사항, 버튼의 title 속성 등 활용)
                const popupTitle = $(this).attr('title') || '프롬프트 편집'; // 버튼의 title 사용
                await callGenericPopup(wrapper, POPUP_TYPE.TEXT, popupTitle, { wide: true, large: true });
                // 팝업이 닫힌 후 포커스를 원래 버튼이나 다른 곳으로 이동시킬 수 있음 (선택적)
                $(this).focus();
            } else {
                console.error('[LLM Translator] callGenericPopup or POPUP_TYPE.TEXT is not available.');
                toastr.error('SillyTavern의 팝업 기능을 사용할 수 없습니다.');
            }
        } catch (error) {
            console.error('[LLM Translator] Error calling callGenericPopup:', error);
            toastr.error('팝업을 여는 중 오류가 발생했습니다.');
        }
    });


    // 번역 표시 모드 변경 이벤트 핸들러 추가
    $('#translation_display_mode').off('change').on('change', function () {
        const selectedMode = $(this).val(); // 선택된 값 가져오기
        extensionSettings.translation_display_mode = selectedMode; // 설정 객체 업데이트
        saveSettingsDebounced(); // 변경 사항 저장
        // console.log(`[LLM Translator] Saved translation_display_mode: ${selectedMode}`); // 디버깅용 로그 (선택 사항)
    });

    // DB 삭제 버튼에 이벤트 리스너 추가
    const deleteButton = document.getElementById("llm_translation_delete");
    deleteButton.addEventListener("click", deleteDB);

    // 다운로드 버튼에 이벤트 리스너 추가
    const downloadButton = document.getElementById("llm_translation_download");
    downloadButton.addEventListener("click", downloadDB);

    // 복원 버튼에 이벤트 리스너 추가
    const restoreButton = document.getElementById("llm_translation_restore");
    restoreButton.addEventListener("change", function (event) {
        const file = event.target.files[0];
        if (file) {
            restoreDB(file);
        }
    });

    // db tool setup 버튼
    $('#llm_translator_db_tool_setup_button').off('click').on('click', async function () {
        await prepareQrAndCharacterForDbManagement();
    });

    // 핵심 버튼 이벤트 핸들러 (공식 스크립트 스타일)
    $('#llm_translate_chat').on('click', onTranslateChatClick);
    $('#llm_translate_input_message').on('click', onTranslateInputMessageClick);
    $('#llm_translation_clear').on('click', onTranslationsClearClick);

    // 설정 변경 이벤트 핸들러
    $('#llm_provider').on('change', function () {
        const provider = $(this).val();
        extensionSettings.llm_provider = provider;
        updateModelList();
        updateParameterVisibility(provider);
        loadParameterValues(provider);
        saveSettingsDebounced();
    });

    // llmContext 슬라이더/체크박스 이벤트 핸들러
    $('#llm_context_message_count').on('input', function () {
        const value = $(this).val();
        $('#llm_context_message_count_value').val(value);
        extensionSettings.context_message_count = parseInt(value);
        saveSettingsDebounced();
    });

    $('#llm_context_message_count_value').on('change', function () {
        const value = Math.min(20, Math.max(1, parseInt($(this).val()) || 5));
        $(this).val(value);
        $('#llm_context_message_count').val(value);
        extensionSettings.context_message_count = value;
        saveSettingsDebounced();
    });

    $('#llm_context_include_user').on('change', function () {
        extensionSettings.context_include_user = $(this).is(':checked');
        saveSettingsDebounced();
    });

    $('#llm_context_exclude_last').on('change', function () {
        extensionSettings.context_exclude_last = $(this).is(':checked');
        saveSettingsDebounced();
    });

    $('#llm_model').on('change', function () {
        const provider = $('#llm_provider').val();
        const selectedModel = $(this).val();
        extensionSettings.llm_model = selectedModel;
        extensionSettings.provider_model_history[provider] = selectedModel;

        // custom 선택 시 커스텀 입력 필드 표시
        if (selectedModel === 'custom') {
            $('#custom_model_container').show();
            $('#llm_custom_model').val(extensionSettings.custom_model || '');
        } else {
            $('#custom_model_container').hide();
        }

        saveSettingsDebounced();
    });

    // 커스텀 모델명 입력 이벤트
    $('#llm_custom_model').on('input', function () {
        extensionSettings.custom_model = $(this).val().trim();
        saveSettingsDebounced();
    });

    // 프롬프트 관리는 이제 PromptManager 클래스에서 처리됩니다

    // 파라미터 슬라이더 동기화
    $('.parameter-settings input').on('input change', function () {
        const provider = $('#llm_provider').val();

        if ($(this).hasClass('neo-range-slider')) {
            $(this).next('.neo-range-input').val($(this).val());
        } else if ($(this).hasClass('neo-range-input')) {
            $(this).prev('.neo-range-slider').val($(this).val());
        }

        saveParameterValues(provider);
    });

    // 체크박스 이벤트 핸들러들 (단순화)
    $('#llm_translation_button_toggle').on('change', function () {
        extensionSettings.show_input_translate_button = $(this).is(':checked');
        saveSettingsDebounced();
        updateInputTranslateButton();
    });

    $('#auto_translate_new_messages').on('change', function () {
        extensionSettings.auto_translate_new_messages = $(this).is(':checked');
        saveSettingsDebounced();
    });

    $('#force_sequential_matching').on('change', function () {
        extensionSettings.force_sequential_matching = $(this).is(':checked');
        saveSettingsDebounced();
    });

    $('#llm_prefill_toggle').on('change', function () {
        extensionSettings.llm_prefill_toggle = $(this).is(':checked');
        saveSettingsDebounced();
    });

    // 버튼 가시성 설정 (통합)
    $('#hide_legacy_translate_button, #hide_toggle_button, #hide_new_translate_button, #hide_paragraph_button, #hide_edit_button, #hide_delete_button').on('change', function () {
        const setting = $(this).attr('id');
        extensionSettings[setting] = $(this).is(':checked');
        saveSettingsDebounced();
        updateButtonVisibility();
    });

    // ===== SillyTavern 기본 번역 로직 채택 =====

    // 이벤트 핸들러 등록 (SillyTavern 스타일)
    eventSource.makeFirst(event_types.CHARACTER_MESSAGE_RENDERED, handleIncomingMessage);
    eventSource.makeFirst(event_types.USER_MESSAGE_RENDERED, handleOutgoingMessage);
    eventSource.on(event_types.MESSAGE_SWIPED, (messageId) => {
        // 스와이프시 이전 번역 진행 상태 정리
        if (translationInProgress[messageId]) {
            translationInProgress[messageId] = false;
        }

        // 스와이프시 이전 번역문도 정리 (새 원문에 대한 번역을 위해)
        const context = getContext();
        const message = context.chat[messageId];
        if (message?.extra?.display_text) {
            delete message.extra.display_text;

            // UI에서도 showing-original 플래그 초기화
            const messageBlock = $(`#chat .mes[mesid="${messageId}"]`);
            const textBlock = messageBlock.find('.mes_text');
            textBlock.removeData('showing-original');
        }

        handleIncomingMessage(messageId);
    });
    eventSource.on(event_types.MESSAGE_UPDATED, handleMessageEdit);

    // 메세지에 자동 번역버튼 추가
    if (!window.llmTranslatorObserver) {
        window.llmTranslatorObserver = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.classList?.contains('mes')) {
                        const $node = $(node);
                        if (!$node.find('.mes_llm_translate').length) {
                            createTranslateButtons($node);
                            // 새로 생성된 버튼들의 가시성 업데이트
                            setTimeout(() => updateButtonVisibility(), 10);
                        }
                    }
                });
            });
        });

        window.llmTranslatorObserver.observe(document.getElementById('chat'), {
            childList: true,
            subtree: true
        });
    }

    // 기존 메시지에 아이콘 추가
    addButtonsToExistingMessages();

    // 설정에 따라 버튼 가시성 업데이트
    updateButtonVisibility();

    // 메시지 버튼 클릭 이벤트 (통합된 위임 방식)
    $(document).on('click', '.mes .mes_legacy_translate', function () {
        const messageId = $(this).closest('.mes').attr('mesid');
        translateMessage(messageId, true, 'manual');
    })
        .on('click', '.mes .mes_llm_translate', function () {
            const messageId = $(this).closest('.mes').attr('mesid');
            handleTranslateButtonClick(messageId);
        })
        .on('click', '.mes .mes_toggle_original', function () {
            const messageId = $(this).closest('.mes').attr('mesid');
            toggleOriginalText(messageId);
        })
        .on('click', '.mes .mes_edit_translation', function () {
            const messageId = $(this).closest('.mes').attr('mesid');
            editTranslation(messageId);
        })
        .on('click', '.mes .mes_paragraph_correction', function () {
            const messageId = $(this).closest('.mes').attr('mesid');
            retranslateMessage(messageId, 'paragraph', true);
        })
        .on('click', '.mes .mes_delete_translation', function () {
            const messageId = $(this).closest('.mes').attr('mesid');
            deleteTranslationById(messageId).catch(error => {
                console.error('Delete translation error:', error);
                toastr.error('번역문 삭제 중 오류가 발생했습니다.');
            });
        });

    // 채팅 변경 시 아이콘 추가 및 규칙 프롬프트 로딩을 위해 이벤트 핸들러 등록
    eventSource.on(event_types.CHAT_CHANGED, function () {
        setTimeout(() => {
            addButtonsToExistingMessages();
            updateButtonVisibility(); // 설정에 따라 버튼 가시성 업데이트
            loadRulePrompt(); // 채팅이 바뀔 때마다 해당 채팅의 규칙 프롬프트 로드
        }, 100);
    });

    // 추가 설정 이벤트 핸들러들 (통합)
    $('#throttle_delay').on('input change', function () {
        extensionSettings.throttle_delay = $(this).val();
        saveSettingsDebounced();
    });

    // 리버스 프록시 설정들 (통합)
    $('#llm_use_reverse_proxy, #llm_reverse_proxy_url, #llm_reverse_proxy_password').on('change input', function () {
        saveReverseProxySettings();
    });

    $('#llm_reverse_proxy_password_show').on('click', function () {
        const passwordInput = $('#llm_reverse_proxy_password');
        const type = passwordInput.attr('type') === 'password' ? 'text' : 'password';
        passwordInput.attr('type', type);
        $(this).toggleClass('fa-eye-slash fa-eye');
    });

    // 규칙 프롬프트 이벤트 핸들러
    $('#llm_rule_prompt').on('input change', saveRulePrompt);

    // 규칙 프롬프트 편집 버튼 클릭 리스너 추가
    $(document).off('click', '.rule-prompt-editor-button').on('click', '.rule-prompt-editor-button', async function () {
        // 규칙 프롬프트 textarea 가져오기
        const rulePromptTextarea = $('#llm_rule_prompt');

        // textarea를 찾았는지 확인
        if (!rulePromptTextarea.length) {
            console.error('[LLM Translator] Could not find rule prompt textarea');
            toastr.error('규칙 프롬프트 텍스트 영역을 찾을 수 없습니다.');
            return;
        }

        // 팝업에 표시할 요소들 생성
        const wrapper = document.createElement('div');
        wrapper.classList.add('height100p', 'wide100p', 'flex-container', 'flexFlowColumn');

        const popupTextarea = document.createElement('textarea');
        popupTextarea.value = rulePromptTextarea.val(); // 현재 규칙 프롬프트 내용 복사
        popupTextarea.classList.add('height100p', 'wide100p');

        // 팝업 textarea 변경 시 원본 textarea 및 메타데이터 실시간 업데이트
        popupTextarea.addEventListener('input', function () {
            // 원본 textarea 값 변경
            rulePromptTextarea.val(popupTextarea.value).trigger('input');

            // 규칙 프롬프트를 채팅 메타데이터에 저장
            const context = getContext();
            if (context) {
                if (!context.chatMetadata) {
                    context.chatMetadata = {};
                }
                context.chatMetadata[RULE_PROMPT_KEY] = popupTextarea.value;
                saveMetadataDebounced();
            }
        });

        wrapper.appendChild(popupTextarea);

        // SillyTavern의 callGenericPopup 호출
        try {
            if (typeof callGenericPopup === 'function' && typeof POPUP_TYPE !== 'undefined' && POPUP_TYPE.TEXT) {
                const popupTitle = '규칙 프롬프트 편집';
                await callGenericPopup(wrapper, POPUP_TYPE.TEXT, popupTitle, { wide: true, large: true });
                $(this).focus();
            } else {
                console.error('[LLM Translator] callGenericPopup or POPUP_TYPE.TEXT is not available.');
                toastr.error('SillyTavern의 팝업 기능을 사용할 수 없습니다.');
            }
        } catch (error) {
            console.error('[LLM Translator] Error calling callGenericPopup:', error);
            toastr.error('팝업을 여는 중 오류가 발생했습니다.');
        }
    });


}



















// IndexedDB 연결 함수
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);

        request.onerror = (event) => {
            reject(new Error("indexedDB open error"));
        };

        request.onsuccess = (event) => {
            resolve(event.target.result);
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            const objectStore = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            objectStore.createIndex('originalText', 'originalText', { unique: false });
            objectStore.createIndex('provider', 'provider', { unique: false }); // 프로바이더 인덱스 추가
            objectStore.createIndex('model', 'model', { unique: false }); // 모델 인덱스 추가
            objectStore.createIndex('date', 'date', { unique: false }); // 날짜 인덱스 추가
        };
    })
}

// 데이터 추가 함수 수정
async function addTranslationToDB(originalText, translation) {
    const db = await openDB();
    const provider = extensionSettings.llm_provider;
    const model = extensionSettings.llm_model;

    // UTC 시간을 ISO 문자열로 가져오기
    const utcDate = new Date();

    // 한국 시간으로 변환 (UTC+9)
    const koreanDate = new Date(utcDate.getTime() + (9 * 60 * 60 * 1000)); // UTC+9 시간

    // ISO 문자열로 저장
    const date = koreanDate.toISOString();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);

        const request = store.add({ originalText: originalText, translation: translation, provider: provider, model: model, date: date });

        request.onsuccess = (event) => {
            resolve("add success");
        };
        request.onerror = (event) => {
            reject(new Error("add error"));
        };
        transaction.oncomplete = function () {
            db.close();
        };

    });
}

// 모든 데이터 가져오기
async function getAllTranslationsFromDB() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();

        request.onsuccess = (event) => {
            resolve(event.target.result);
        };
        request.onerror = (event) => {
            reject(new Error("get all error"));
        };

        transaction.oncomplete = function () {
            db.close();
        };
    })
}

// 다운로드
async function downloadDB() {
    const data = await getAllTranslationsFromDB();
    if (data && data.length > 0) {
        const jsonData = JSON.stringify(data);
        const blob = new Blob([jsonData], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;

        // 브라우저 이름 가져오기
        const browserName = getBrowserName();

        // 현재 날짜와 시간을 DD_HH 형식으로 파일명에 추가
        const now = new Date();
        const formattedDate = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;

        a.download = `${browserName}_SillyLLMtranslations_${formattedDate}.json`;

        a.click();
        URL.revokeObjectURL(url);
    } else {
        toastr.error('저장된 데이터가 없습니다.');
    }
}


// 브라우저 이름 가져오는 함수
function getBrowserName() {
    const userAgent = navigator.userAgent;
    let browserName = 'Unknown';

    if (userAgent.indexOf('Chrome') > -1) {
        browserName = 'Chrome';
    } else if (userAgent.indexOf('Firefox') > -1) {
        browserName = 'Firefox';
    } else if (userAgent.indexOf('Safari') > -1) {
        browserName = 'Safari';
    } else if (userAgent.indexOf('Edge') > -1) {
        browserName = 'Edge';
    } else if (userAgent.indexOf('Opera') > -1 || userAgent.indexOf('OPR') > -1) {
        browserName = 'Opera';
    }

    return browserName;
}

//DB 복원
async function restoreDB(file) {
    const db = await openDB();
    const reader = new FileReader();
    reader.onload = async function (event) {
        try {
            const backupData = JSON.parse(event.target.result);
            return new Promise(async (resolve, reject) => {
                const transaction = db.transaction(STORE_NAME, 'readwrite');
                const store = transaction.objectStore(STORE_NAME);

                for (const item of backupData) {
                    const index = store.index('originalText');
                    const request = index.get(item.originalText);

                    await new Promise((resolveGet) => {
                        request.onsuccess = async (event) => {
                            const record = event.target.result;
                            if (record) {
                                // 기존에 데이터가 있으면 갱신
                                await new Promise((resolvePut) => {
                                    const updateRequest = store.put({ ...record, translation: item.translation, provider: item.provider, model: item.model, date: item.date });
                                    updateRequest.onsuccess = () => {
                                        resolvePut();
                                    }
                                    updateRequest.onerror = (e) => {
                                        reject(new Error("restore put error"));
                                        resolvePut();
                                    }
                                })
                            } else {
                                // 없으면 추가
                                await new Promise((resolveAdd) => {
                                    const addRequest = store.add(item);
                                    addRequest.onsuccess = () => {
                                        resolveAdd();
                                    }
                                    addRequest.onerror = (e) => {
                                        reject(new Error("restore add error"));
                                        resolveAdd();
                                    }
                                })
                            }
                            resolveGet();
                        }
                        request.onerror = (e) => {
                            reject(new Error("restore get error"));
                            resolveGet();
                        }
                    })
                }

                transaction.oncomplete = function () {
                    db.close();
                    toastr.success('데이터를 복원했습니다.');
                    resolve();
                }

                transaction.onerror = function (event) {
                    db.close();
                    reject(new Error("restore transaction error"));
                }
            });
        } catch (e) {
            toastr.error("올바르지 않은 파일형식입니다.");
        }
    }
    reader.readAsText(file);
}


// 데이터 업데이트 함수 수정
async function updateTranslationByOriginalText(originalText, newTranslation) {
    const db = await openDB();
    const provider = extensionSettings.llm_provider;
    const model = extensionSettings.llm_model;

    // UTC 시간을 ISO 문자열로 가져오기
    const utcDate = new Date();

    // 한국 시간으로 변환 (UTC+9)
    const koreanDate = new Date(utcDate.getTime() + (9 * 60 * 60 * 1000)); // UTC+9 시간

    // ISO 문자열로 저장
    const date = koreanDate.toISOString();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('originalText');
        const request = index.get(originalText);

        request.onsuccess = async (event) => {
            const record = event.target.result;

            if (record) {
                const updateRequest = store.put({ ...record, translation: newTranslation, provider: provider, model: model, date: date });
                updateRequest.onsuccess = () => {
                    resolve();
                };
                updateRequest.onerror = (e) => {
                    reject(new Error('put error'));
                };
            } else {
                reject(new Error('no matching data'));
            }
        };
        request.onerror = (e) => {
            reject(new Error('get error'));
        };
        transaction.oncomplete = function () {
            db.close();
        };
    });
}

// IndexedDB에서 번역 데이터 가져오는 함수
async function getTranslationFromDB(originalText) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('originalText');
        const request = index.get(originalText);

        request.onsuccess = (event) => {
            const record = event.target.result;
            resolve(record ? record.translation : null);
        };
        request.onerror = (e) => {
            reject(new Error("get error"));
        };
        transaction.oncomplete = function () {
            db.close();
        };
    });
}


// IndexedDB 삭제 함수
async function deleteDB() {
    const confirm = await callGenericPopup(
        '모든 번역 데이터를 삭제하시겠습니까?',
        POPUP_TYPE.CONFIRM
    );

    if (!confirm) {
        return;
    }

    return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(DB_NAME);
        request.onsuccess = () => {
            toastr.success('모든 번역 데이터가 삭제되었습니다.');
            resolve();
        };
        request.onerror = (event) => {
            toastr.error('데이터 삭제에 실패했습니다.');
            reject(new Error("db delete error"));
        };
    });
}


// IndexedDB 데이터 삭제 함수 (originalText 기반)
async function deleteTranslationByOriginalText(originalText) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('originalText');
        const request = index.get(originalText);

        request.onsuccess = async (event) => {
            const record = event.target.result;
            if (record) {
                const deleteRequest = store.delete(record.id);
                deleteRequest.onsuccess = () => {
                    resolve();
                }
                deleteRequest.onerror = (e) => {
                    reject(new Error('delete error'));
                }
            } else {
                reject(new Error('no matching data'));
            }
        }
        request.onerror = (e) => {
            reject(new Error('get error'));
        };
        transaction.oncomplete = function () {
            db.close();
        };
    })
}

//----------v3


// --- 로깅 헬퍼 ---
function logDebug(...args) {
    if (DEBUG_MODE) {
        console.log(`[${extensionName} Debug]`, ...args);
    }
}


// --- 메타데이터 기반 백업/복원/정리 함수 ---

/**
 * 현재 브라우저의 번역 캐시(IndexedDB)를 현재 로드된 채팅의 메타데이터에 백업합니다.
 * @returns {Promise<void>}
 */
async function backupTranslationsToMetadata() {
    const DEBUG_PREFIX = `[${extensionName} - Backup]`;
    if (isChatTranslationInProgress) {
        toastr.warning('이미 백업 작업이 진행 중입니다.');
        logDebug('Backup already in progress. Exiting.');
        return;
    }

    // 백업용 챗봇 확인 로직 (선택적이지만 권장)
    // const context = getContext();
    // if (context.characterId !== 'YOUR_BACKUP_BOT_ID') {
    //     toastr.error('이 작업은 백업용으로 지정된 캐릭터/채팅에서만 실행해야 합니다.');
    //     logDebug('Backup attempt on non-backup chat cancelled.');
    //     return;
    // }

    try {
        isChatTranslationInProgress = true;
        toastr.info('번역 캐시 백업 시작... (데이터 양에 따라 시간이 걸릴 수 있습니다)');
        logDebug('Starting backup to metadata...');

        const context = getContext(); // 이미 import 되어 있음
        if (!context || !context.chatMetadata) {
            throw new Error('컨텍스트 또는 메타데이터를 찾을 수 없습니다.');
        }

        logDebug('Context and metadata found.');

        // 1. IndexedDB에서 모든 데이터 가져오기
        const allTranslations = await getAllTranslationsFromDB();

        if (!allTranslations || allTranslations.length === 0) {
            toastr.info('백업할 번역 데이터가 없습니다.');
            logDebug('No translation data found in IndexedDB to back up.');
            return; // 작업 종료
        }
        logDebug(`Retrieved ${allTranslations.length} translation items from IndexedDB.`);

        // 2. 데이터 직렬화 (JSON 문자열로 변환)
        // **대용량 처리:** 필요 시 여기서 pako.js 압축 로직 추가
        const backupDataString = JSON.stringify(allTranslations);
        logDebug(`Data stringified. Length: ${backupDataString.length} bytes.`);

        // 3. 메타데이터에 저장
        if (typeof context.chatMetadata !== 'object' || context.chatMetadata === null) {
            logDebug('chatMetadata is not an object, initializing.');
            context.chatMetadata = {};
        }
        context.chatMetadata[METADATA_BACKUP_KEY] = backupDataString;
        logDebug(`Stored backup string in chatMetadata under key: ${METADATA_BACKUP_KEY}`);

        // 4. 서버에 메타데이터 저장 요청
        saveMetadataDebounced();
        logDebug('saveMetadataDebounced() called to trigger server save.');

        toastr.success(`번역 캐시 백업 완료! (${allTranslations.length}개 항목)`);
        logDebug('Backup completed successfully.');

    } catch (error) {
        console.error(`${DEBUG_PREFIX} Error during backup:`, error);
        toastr.error(`백업 중 오류 발생: ${error.message || '알 수 없는 오류'}`);
    } finally {
        isChatTranslationInProgress = false;
        logDebug('Backup process finished.');
    }
}

/**
 * 현재 로드된 채팅의 메타데이터에서 번역 캐시 백업을 복원하여
 * 현재 브라우저의 IndexedDB에 **존재하지 않는 데이터만 추가**합니다.
 * 진행 상황을 **직접 생성한 프로그레스 바로** 표시합니다.
 * @returns {Promise<void>}
 */
async function restoreTranslationsFromMetadata() {
    const DEBUG_PREFIX = `[${extensionName} - Restore AddOnly Progress]`;
    if (isChatTranslationInProgress) {
        toastr.warning('이미 복원 작업이 진행 중입니다.');
        logDebug('Restore already in progress. Exiting.');
        return;
    }

    // 복원용 챗봇 확인 로직 (선택적)

    // --- 프로그레스 바 UI 요소 참조를 위한 변수 ---
    let progressContainer = null;
    let progressBarInner = null;
    let progressLabel = null;
    // ---

    try {
        isChatTranslationInProgress = true;
        logDebug('Starting restore from metadata (Add-Only mode)...');
        // Toastr 시작 메시지 제거 (프로그레스 바가 대신함)

        const context = getContext();
        if (!context || !context.chatMetadata) {
            throw new Error('컨텍스트 또는 메타데이터를 찾을 수 없습니다.');
        }
        logDebug('Context and metadata found.');

        // 1. 메타데이터에서 백업 데이터 가져오기
        const backupDataString = context.chatMetadata[METADATA_BACKUP_KEY];
        if (!backupDataString || typeof backupDataString !== 'string') {
            toastr.warning('현재 채팅에 저장된 번역 백업 데이터가 없습니다.');
            logDebug(`No backup data found in metadata for key: ${METADATA_BACKUP_KEY}`);
            return; // 복원할 데이터 없으면 종료
        }
        logDebug(`Retrieved backup string from metadata. Length: ${backupDataString.length} bytes.`);

        // 2. 데이터 역직렬화 (JSON 파싱)
        // **대용량 처리:** 필요 시 여기서 pako.js 압축 해제 로직 추가
        let backupData;
        try {
            backupData = JSON.parse(backupDataString);
            if (!Array.isArray(backupData)) throw new Error('백업 데이터 형식이 올바르지 않습니다 (배열이 아님).');
            logDebug(`Backup data parsed successfully. Items: ${backupData.length}`);
        } catch (parseError) {
            console.error(`${DEBUG_PREFIX} Error parsing backup data:`, parseError);
            throw new Error('백업 데이터를 파싱하는 중 오류가 발생했습니다.');
        }

        const totalItems = backupData.length;
        if (totalItems === 0) {
            toastr.info('백업 데이터에 복원할 항목이 없습니다.');
            logDebug('Backup data array is empty. Nothing to restore.');
            return; // 복원할 항목 없으면 종료
        }
        logDebug(`Starting restore process for ${totalItems} items.`);

        // --- 프로그레스 바 UI 동적 생성 ---
        logDebug('Creating progress bar UI...');
        progressContainer = document.createElement('div');
        progressContainer.id = 'llm-translator-progress-blocker';
        progressContainer.style.position = 'fixed';
        progressContainer.style.top = '0';
        progressContainer.style.left = '0';
        progressContainer.style.width = '100%';
        progressContainer.style.height = '100%';
        progressContainer.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
        progressContainer.style.zIndex = '10000';
        progressContainer.style.display = 'flex';
        progressContainer.style.justifyContent = 'center';
        progressContainer.style.alignItems = 'center';

        const progressContent = document.createElement('div');
        progressContent.style.backgroundColor = '#333';
        progressContent.style.padding = '20px';
        progressContent.style.borderRadius = '8px';
        progressContent.style.color = 'white';
        progressContent.style.textAlign = 'center';
        progressContent.style.minWidth = '300px';

        const progressTitle = document.createElement('div');
        progressTitle.textContent = '번역 캐시 복원 중...';
        progressTitle.style.marginBottom = '15px';
        progressTitle.style.fontSize = '1.2em';

        const progressBarOuter = document.createElement('div');
        progressBarOuter.style.backgroundColor = '#555';
        progressBarOuter.style.borderRadius = '5px';
        progressBarOuter.style.overflow = 'hidden';
        progressBarOuter.style.height = '20px';
        progressBarOuter.style.marginBottom = '10px';
        progressBarOuter.style.position = 'relative';

        progressBarInner = document.createElement('div');
        progressBarInner.style.backgroundColor = '#4CAF50';
        progressBarInner.style.height = '100%';
        progressBarInner.style.width = '0%';
        progressBarInner.style.transition = 'width 0.1s linear';

        progressLabel = document.createElement('div');
        progressLabel.textContent = `0 / ${totalItems} (0%)`;
        progressLabel.style.fontSize = '0.9em';

        progressBarOuter.appendChild(progressBarInner);
        progressContent.appendChild(progressTitle);
        progressContent.appendChild(progressBarOuter);
        progressContent.appendChild(progressLabel);
        progressContainer.appendChild(progressContent);
        document.body.appendChild(progressContainer);
        logDebug('Progress bar UI created and appended to body.');
        // --- 프로그레스 바 UI 생성 끝 ---


        // 3. IndexedDB에 데이터 병합 (Add-Only 로직 적용)
        let addedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;

        for (let i = 0; i < totalItems; i++) {
            const item = backupData[i];
            const currentProgress = i + 1;

            // --- 프로그레스 바 업데이트 ---
            const progressPercentage = (currentProgress / totalItems) * 100;
            progressBarInner.style.width = `${progressPercentage}%`;
            progressLabel.textContent = `${currentProgress} / ${totalItems} (${Math.round(progressPercentage)}%)`;
            // ---

            // UI 멈춤 방지 및 진행률 로그 (예: 100개 마다)
            if (i > 0 && i % 100 === 0) {
                logDebug(`Restore progress: ${currentProgress}/${totalItems} (${Math.round(progressPercentage)}%)`);
                await new Promise(resolve => setTimeout(resolve, 0));
            }

            // 필수 필드 확인
            if (!item || typeof item.originalText !== 'string' || typeof item.translation !== 'string') {
                logDebug(`Skipping invalid item at index ${i}:`, item);
                errorCount++; // 유효하지 않은 항목은 오류로 간주
                continue;
            }

            // 데이터 병합 로직 (Add-Only)
            try {
                // logDebug(`Checking local DB for item ${i}: "${item.originalText.substring(0,30)}..."`); // 개별 확인 로그 (너무 많을 수 있음)
                const localTranslationExists = await getTranslationFromDB(item.originalText) !== null;

                if (!localTranslationExists) {
                    // logDebug(`Item ${i} not found locally. Adding...`); // 개별 추가 로그
                    await addTranslationToDB(item.originalText, item.translation /*, item.provider, item.model, item.date */);
                    addedCount++;
                } else {
                    // logDebug(`Item ${i} already exists locally. Skipping.`); // 개별 스킵 로그
                    skippedCount++;
                }
            } catch (dbError) {
                console.error(`${DEBUG_PREFIX} Error processing item at index ${i} (original: ${item.originalText.substring(0, 50)}...):`, dbError);
                errorCount++;
            }
        }

        // 최종 결과 로그 및 알림 (기존과 동일)
        logDebug(`Restore (Add-Only) completed. Added: ${addedCount}, Skipped (Existing): ${skippedCount}, Errors: ${errorCount}`);
        if (errorCount > 0) {
            toastr.warning(`복원 완료. ${addedCount}개 추가, ${skippedCount}개 건너뜀. ${errorCount}개 오류 발생.`);
        } else {
            toastr.success(`번역 캐시 복원 완료! (${addedCount}개 추가, ${skippedCount}개 건너뜀)`);
        }

        // 복원 후 메타데이터 자동 삭제 안 함
        // 필요 시 /llmClearBackup 커맨드를 사용
        logDebug('Metadata backup was NOT automatically cleared after restore (as requested).');

        // UI 갱신 필요 시 추가

    } catch (error) {
        console.error(`${DEBUG_PREFIX} Error during restore:`, error);
        toastr.error(`복원 중 오류 발생: ${error.message || '알 수 없는 오류'}`);
    } finally {
        // --- 프로그레스 바 UI 제거 ---
        if (progressContainer && document.body.contains(progressContainer)) {
            logDebug('Removing progress bar UI.');
            document.body.removeChild(progressContainer);
        } else {
            logDebug('Progress bar UI was not found or already removed.');
        }
        // ---
        isChatTranslationInProgress = false;
        logDebug('Restore process finished.');
    }
}

/**
 * 현재 로드된 채팅의 메타데이터에서 번역 캐시 백업을 삭제합니다.
 * @returns {Promise<void>}
 */
async function clearBackupFromMetadata() {
    const DEBUG_PREFIX = `[${extensionName} - Cleanup]`;
    if (isChatTranslationInProgress) {
        toastr.warning('이미 정리 작업이 진행 중입니다.');
        logDebug('Cleanup already in progress. Exiting.');
        return;
    }

    // 정리용 챗봇 확인 로직 (선택적)

    logDebug('Requesting metadata backup cleanup...');
    const confirm = await callGenericPopup(
        '현재 채팅에 저장된 번역 캐시 백업을 삭제하시겠습니까?\n(주의: 복구할 수 없습니다!)',
        POPUP_TYPE.CONFIRM
    );

    if (!confirm) {
        logDebug('Metadata cleanup cancelled by user.');
        toastr.info('백업 데이터 삭제가 취소되었습니다.');
        return;
    }
    logDebug('User confirmed metadata cleanup.');

    try {
        isChatTranslationInProgress = true;
        toastr.info('백업 데이터 삭제 시작...');
        logDebug('Starting cleanup of metadata backup...');

        const context = getContext();
        if (!context || !context.chatMetadata) {
            throw new Error('컨텍스트 또는 메타데이터를 찾을 수 없습니다.');
        }
        logDebug('Context and metadata found.');

        if (context.chatMetadata.hasOwnProperty(METADATA_BACKUP_KEY)) {
            logDebug(`Found backup data under key: ${METADATA_BACKUP_KEY}. Deleting...`);
            delete context.chatMetadata[METADATA_BACKUP_KEY]; // 메타데이터에서 키 삭제
            saveMetadataDebounced(); // 변경사항 저장 요청
            logDebug('saveMetadataDebounced() called to trigger server save.');
            toastr.success('채팅에 저장된 번역 캐시 백업이 삭제되었습니다.');
        } else {
            logDebug(`No backup data found under key: ${METADATA_BACKUP_KEY}. Nothing to delete.`);
            toastr.info('현재 채팅에 삭제할 번역 캐시 백업이 없습니다.');
        }
        logDebug('Cleanup completed successfully.');

    } catch (error) {
        console.error(`${DEBUG_PREFIX} Error during cleanup:`, error);
        toastr.error(`백업 데이터 삭제 중 오류 발생: ${error.message || '알 수 없는 오류'}`);
    } finally {
        isChatTranslationInProgress = false;
        logDebug('Cleanup process finished.');
    }
}

/**
 * 지정된 메시지 ID에 해당하는 번역문을 IndexedDB에서 가져옵니다.
 * @param {string} messageIdStr - 번역문을 가져올 메시지의 ID (문자열 형태)
 * @returns {Promise<string>} 번역문 또는 오류 메시지
 */
async function getTranslationById(messageIdStr) {
    const DEBUG_PREFIX = `[${extensionName} - GetByID]`;
    logDebug(`Attempting to get translation for message ID: ${messageIdStr}`);

    // 1. 메시지 ID 파싱 및 유효성 검사
    const messageId = parseInt(messageIdStr, 10);
    if (isNaN(messageId) || messageId < 0) {
        const errorMsg = `유효하지 않은 메시지 ID: "${messageIdStr}". 숫자를 입력하세요.`;
        logDebug(errorMsg);
        return errorMsg;
    }

    // 2. 컨텍스트 및 대상 메시지 가져오기
    const context = getContext();
    if (!context || !context.chat) {
        const errorMsg = '컨텍스트 또는 채팅 데이터를 찾을 수 없습니다.';
        logDebug(errorMsg);
        return `오류: ${errorMsg}`;
    }
    if (messageId >= context.chat.length) {
        const errorMsg = `메시지 ID ${messageId}를 찾을 수 없습니다. (채팅 길이: ${context.chat.length})`;
        logDebug(errorMsg);
        return errorMsg;
    }
    const message = context.chat[messageId];
    if (!message) {
        const errorMsg = `메시지 ID ${messageId}에 대한 데이터를 가져올 수 없습니다.`;
        logDebug(errorMsg);
        return `오류: ${errorMsg}`;
    }

    // 3. 원본 텍스트 가져오기 (DB 검색 키)
    const originalText = substituteParams(message.mes, context.name1, message.name);
    if (!originalText) {
        const errorMsg = `메시지 ID ${messageId}의 원본 텍스트를 가져올 수 없습니다.`;
        logDebug(errorMsg);
        return errorMsg;
    }
    logDebug(`Original text for message ID ${messageId} (used as DB key): "${originalText.substring(0, 50)}..."`);

    // 4. DB에서 해당 번역문 조회
    try {
        const translation = await getTranslationFromDB(originalText);

        if (translation) {
            logDebug(`Translation found for message ID ${messageId}`);
            return translation; // 번역문 반환
        } else {
            const noTranslationMsg = `메시지 ID ${messageId}에 대한 번역문이 DB에 없습니다.`;
            logDebug(noTranslationMsg);
            return noTranslationMsg;
        }

    } catch (error) {
        const errorMsg = `메시지 ID ${messageId}의 번역문 조회 중 오류가 발생했습니다.`;
        console.error(`${DEBUG_PREFIX} Error getting translation for message ID ${messageId}:`, error);
        return `오류: ${errorMsg}`;
    }
}

/**
 * 메시지가 숨겨져 있는지 확인합니다 (SillyTavern 방식)
 * @param {Object} message - 확인할 메시지 객체
 * @returns {boolean} 숨겨진 메시지 여부
 */
function isMessageHidden(message) {
    if (!message) return false;

    // SillyTavern에서 실제로 사용하는 숨김 메시지 체크
    // 숨겨진 메시지는 is_system 속성이 true인 메시지들입니다
    return message.is_system === true;
}

/**
 * 지정된 범위의 메시지들의 번역문을 가져옵니다.
 * @param {string} startIdStr - 시작 메시지 ID (문자열 형태)
 * @param {string} endIdStr - 종료 메시지 ID (문자열 형태)
 * @param {boolean} includeOriginal - 번역문이 없을 때 원문 포함 여부
 * @param {boolean} includeMessageId - 메시지 ID 출력 여부
 * @param {boolean} excludeHidden - 숨겨진 메시지 제외 여부
 * @returns {Promise<string>} 범위 내 번역문들을 연결한 결과
 */
async function getTranslationsInRange(startIdStr, endIdStr, includeOriginal = false, includeMessageId = false, excludeHidden = true) {
    const DEBUG_PREFIX = `[${extensionName} - GetTranslationsInRange]`;
    logDebug(`${DEBUG_PREFIX} Getting translations from ${startIdStr} to ${endIdStr}`);

    // 1. 메시지 ID 파싱 및 유효성 검사
    let startId = parseInt(startIdStr, 10);
    let endId = parseInt(endIdStr, 10);

    if (isNaN(startId) || isNaN(endId) || startId < 0 || endId < 0) {
        const errorMsg = `유효하지 않은 메시지 ID 범위: "${startIdStr}" ~ "${endIdStr}". 숫자를 입력하세요.`;
        logDebug(errorMsg);
        return errorMsg;
    }

    // 범위 순서 확인 및 수정
    if (startId > endId) {
        [startId, endId] = [endId, startId];
        logDebug(`${DEBUG_PREFIX} Swapped range order: ${startId} to ${endId}`);
    }

    // 2. 컨텍스트 및 채팅 데이터 확인
    const context = getContext();
    if (!context || !context.chat) {
        const errorMsg = '컨텍스트 또는 채팅 데이터를 찾을 수 없습니다.';
        logDebug(errorMsg);
        return `오류: ${errorMsg}`;
    }

    const chatLength = context.chat.length;
    if (startId >= chatLength) {
        const errorMsg = `시작 메시지 ID ${startId}를 찾을 수 없습니다. (채팅 길이: ${chatLength})`;
        logDebug(errorMsg);
        return errorMsg;
    }

    // 종료 ID가 범위를 벗어나면 마지막 메시지로 조정
    if (endId >= chatLength) {
        endId = chatLength - 1;
        logDebug(`${DEBUG_PREFIX} Adjusted end ID to ${endId} (chat length: ${chatLength})`);
    }

    // 3. 범위 내 메시지들의 번역문 수집
    const results = [];
    let translationCount = 0;
    let originalCount = 0;
    let hiddenCount = 0;

    for (let messageId = startId; messageId <= endId; messageId++) {
        const message = context.chat[messageId];
        if (!message) {
            logDebug(`${DEBUG_PREFIX} Message ${messageId} not found, skipping`);
            continue;
        }

        // 숨겨진 메시지 체크 (SillyTavern 방식)
        if (excludeHidden && isMessageHidden(message)) {
            logDebug(`${DEBUG_PREFIX} Message ${messageId} is hidden, skipping`);
            hiddenCount++;
            continue;
        }

        // 원본 텍스트 가져오기
        const originalText = substituteParams(message.mes, context.name1, message.name);
        if (!originalText || originalText.trim() === '') {
            logDebug(`${DEBUG_PREFIX} Message ${messageId} has empty content, skipping`);
            continue;
        }

        try {
            // DB에서 번역문 조회
            const translation = await getTranslationFromDB(originalText);

            if (translation && translation.trim() !== '') {
                // 번역문이 있는 경우
                if (includeMessageId) {
                    results.push(`[메시지 ${messageId}]`);
                }
                results.push(translation);
                results.push(''); // 번역문 간 구분을 위해 빈 줄 추가
                translationCount++;
                logDebug(`${DEBUG_PREFIX} Found translation for message ${messageId}`);
            } else if (includeOriginal) {
                // 번역문이 없고 원문 포함 옵션이 켜진 경우
                if (includeMessageId) {
                    results.push(`[메시지 ${messageId} - 원문]`);
                }
                results.push(originalText);
                results.push(''); // 텍스트 간 구분을 위해 빈 줄 추가
                originalCount++;
                logDebug(`${DEBUG_PREFIX} Using original text for message ${messageId}`);
            }
            // includeOriginal이 false이고 번역문이 없으면 해당 메시지는 건너뜀
        } catch (error) {
            logDebug(`${DEBUG_PREFIX} Error getting translation for message ${messageId}:`, error);
            if (includeOriginal) {
                if (includeMessageId) {
                    results.push(`[메시지 ${messageId} - 원문 (오류로 인한 대체)]`);
                }
                results.push(originalText);
                results.push(''); // 텍스트 간 구분을 위해 빈 줄 추가
                originalCount++;
            }
        }
    }

    // 4. 결과 반환
    if (results.length === 0) {
        const noResultMsg = `메시지 ID ${startId}~${endId} 범위에서 ${includeOriginal ? '텍스트' : '번역문'}를 찾을 수 없습니다.`;
        logDebug(`${DEBUG_PREFIX} ${noResultMsg}`);
        return noResultMsg;
    }

    const resultText = results.join('\n');
    let summaryMsg = `메시지 ID ${startId}~${endId} 범위: 번역문 ${translationCount}개${includeOriginal ? `, 원문 ${originalCount}개` : ''}`;
    if (excludeHidden && hiddenCount > 0) {
        summaryMsg += `, 숨김 메시지 ${hiddenCount}개 제외`;
    }
    summaryMsg += ' 추출 완료';
    logDebug(`${DEBUG_PREFIX} ${summaryMsg}`);

    return resultText;
}

/**
 * 지정된 메시지 ID에 해당하는 번역 데이터를 IndexedDB에서 삭제합니다.
 * @param {string} messageIdStr - 삭제할 메시지의 ID (문자열 형태)
 * @param {string} swipeNumberStr - 선택적 스와이프 번호 (문자열 형태)
 * @returns {Promise<string>} 작업 결과 메시지
 */
async function deleteTranslationById(messageIdStr, swipeNumberStr) {
    const DEBUG_PREFIX = `[${extensionName} - DeleteByID]`;
    logDebug(`Attempting to delete translation for message ID: ${messageIdStr}`);

    // 0. 'last' 처리
    let actualMessageIdStr = messageIdStr;
    if (messageIdStr === 'last') {
        const context = getContext();
        if (!context || !context.chat || context.chat.length === 0) {
            const errorMsg = '채팅 메시지가 없습니다.';
            logDebug(errorMsg);
            toastr.error(errorMsg);
            return errorMsg;
        }
        actualMessageIdStr = String(context.chat.length - 1);
        logDebug(`'last' converted to messageId: ${actualMessageIdStr}`);
    }

    // 1. 메시지 ID 파싱 및 유효성 검사
    const messageId = parseInt(actualMessageIdStr, 10);
    if (isNaN(messageId) || messageId < 0) {
        const errorMsg = `유효하지 않은 메시지 ID: "${actualMessageIdStr}". 숫자를 입력하세요.`;
        logDebug(errorMsg);
        toastr.error(errorMsg);
        return errorMsg;
    }

    // 2. 컨텍스트 및 대상 메시지 가져오기
    const context = getContext();
    if (!context || !context.chat) {
        const errorMsg = '컨텍스트 또는 채팅 데이터를 찾을 수 없습니다.';
        logDebug(errorMsg);
        toastr.error(errorMsg);
        return `오류: ${errorMsg}`;
    }
    if (messageId >= context.chat.length) {
        const errorMsg = `메시지 ID ${messageId}를 찾을 수 없습니다. (채팅 길이: ${context.chat.length})`;
        logDebug(errorMsg);
        toastr.error(errorMsg);
        return errorMsg;
    }
    const message = context.chat[messageId];
    if (!message) {
        const errorMsg = `메시지 ID ${messageId}에 대한 데이터를 가져올 수 없습니다.`;
        logDebug(errorMsg);
        toastr.error(errorMsg);
        return `오류: ${errorMsg}`;
    }

    // 3. 원본 텍스트 가져오기 (DB 검색 키)
    // substituteParams를 사용하여 변수 치환된 최종 원본 텍스트를 얻음
    const originalText = substituteParams(message.mes, context.name1, message.name);
    if (!originalText) {
        const errorMsg = `메시지 ID ${messageId}의 원본 텍스트를 가져올 수 없습니다.`;
        logDebug(errorMsg);
        toastr.warning(errorMsg); // 원본이 비어있을 수도 있으니 경고로 처리
        return errorMsg;
    }
    logDebug(`Original text for message ID ${messageId} (used as DB key): "${originalText.substring(0, 50)}..."`);

    // 3.5. 스와이프 번호 처리 (현재는 경고만 표시)
    if (swipeNumberStr && swipeNumberStr.trim() !== '') {
        const swipeNumber = parseInt(swipeNumberStr, 10);
        if (!isNaN(swipeNumber) && swipeNumber > 0) {
            logDebug(`Swipe number ${swipeNumber} was provided, but swipe-specific deletion is not implemented yet.`);
            toastr.warning(`스와이프 번호 ${swipeNumber}가 지정되었지만, 현재는 해당 메시지의 모든 번역 데이터를 삭제합니다.`);
        } else {
            logDebug(`Invalid swipe number: "${swipeNumberStr}". Ignoring and proceeding with full message deletion.`);
        }
    }

    // 4. DB에서 해당 번역 데이터 삭제 시도
    try {
        await deleteTranslationByOriginalText(originalText); // 기존에 만든 DB 삭제 함수 사용

        // 5. 화면(UI)에서도 번역문 제거 (선택적이지만 권장)
        if (message.extra && message.extra.display_text) {
            logDebug(`Removing display_text from message ${messageId} extra data.`);
            delete message.extra.display_text; // 또는 null로 설정: message.extra.display_text = null;
            await updateMessageBlock(messageId, message); // UI 업데이트
            await context.saveChat(); // 변경된 메시지 저장
            logDebug('UI display_text removed and chat saved.');
        } else {
            logDebug(`No display_text found in message ${messageId} extra data to remove from UI.`);
        }

        const successMsg = `메시지 ID ${messageId}의 번역 데이터가 삭제되었습니다.`;
        logDebug(successMsg);
        toastr.success(successMsg);
        return successMsg; // 슬래시 커맨드 결과

    } catch (error) {
        // deleteTranslationByOriginalText 함수에서 reject('no matching data') 할 경우 포함
        let userErrorMessage = `메시지 ID ${messageId}의 번역 데이터 삭제 중 오류가 발생했습니다.`;
        if (error && error.message && error.message.includes('no matching data')) {
            userErrorMessage = `메시지 ID ${messageId}에 해당하는 번역 데이터가 DB에 없습니다.`;
            logDebug(userErrorMessage);
            toastr.info(userErrorMessage); // 정보성으로 변경
        } else {
            console.error(`${DEBUG_PREFIX} Error deleting translation for message ID ${messageId}:`, error);
            toastr.error(userErrorMessage);
        }
        return `오류: ${userErrorMessage}`; // 슬래시 커맨드 결과
    }
}





/**
 * 지정된 이름의 캐릭터가 SillyTavern에 존재하는지 확인합니다.
 * @param {string} characterName - 확인할 캐릭터의 이름
 * @returns {boolean} 캐릭터 존재 여부
 */
function doesCharacterExist(characterName) {
    const context = getContext(); // 이렇게 직접 호출
    if (!context || !context.characters || !Array.isArray(context.characters)) {
        // console.error(`DB_TOOL_SETUP 캐릭터 목록을 가져올 수 없습니다.`);
        // getSillyTavernContext 내부에서 이미 오류를 알렸을 수 있으므로, 중복 알림 자제
        return false;
    }
    const nameLower = characterName.toLowerCase();
    return context.characters.some(char => char && typeof char.name === 'string' && char.name.toLowerCase() === nameLower);
}

/**
 * 지정된 정보로 SillyTavern에 새 캐릭터를 생성합니다.
 * @param {string} characterName - 생성할 캐릭터의 이름
 * @param {string} firstMessage - 캐릭터의 첫 번째 메시지 (소개말)
 * @returns {Promise<boolean>} 캐릭터 생성 성공 여부
 */
async function createSillyTavernCharacter(characterName, firstMessage) {
    const context = getContext(); // 이렇게 직접 호출
    if (!context) return false;

    const characterData = {
        name: characterName,
        description: `LLM 번역 DB 작업을 위해 자동으로 생성된 캐릭터입니다.`,
        personality: "",
        scenario: "",
        first_mes: firstMessage,
        mes_example: "",
        data: {
            name: characterName,
            description: `LLM 번역 DB 작업을 위해 자동으로 생성된 캐릭터입니다.`,
            personality: "",
            scenario: "",
            first_mes: firstMessage,
            mes_example: "",
            tags: ["llm_translation_db_char", "auto-created"],
            avatar: 'none',
            alternate_greetings: [],
        },
        avatar: 'none',
        tags: ["llm_translation_db_char", "auto-created"],
        spec: 'chara_card_v2',
        spec_version: '2.0',
    };

    const formData = new FormData();
    formData.append('avatar', new Blob([JSON.stringify(characterData)], { type: 'application/json' }), `${characterName}.json`);
    formData.append('file_type', 'json');

    const headers = context.getRequestHeaders ? context.getRequestHeaders() : {};
    if (headers['Content-Type']) {
        delete headers['Content-Type'];
    }

    try {
        const response = await fetch('/api/characters/import', {
            method: 'POST',
            headers: headers,
            body: formData,
            cache: 'no-cache',
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`DB_TOOL_SETUP 캐릭터 '${characterName}' 가져오기 실패. 상태: ${response.status} - ${response.statusText}. 본문: ${errorText}`);
            if (window.toastr) toastr.error(`캐릭터 '${characterName}' 생성 실패: ${response.statusText}`);
            return false;
        }

        if (typeof context.getCharacters === 'function') {
            await context.getCharacters();
        }

        if (window.toastr) toastr.success(`캐릭터 "${characterName}"이(가) 성공적으로 생성되었습니다!`);
        return true;

    } catch (error) {
        console.error(`DB_TOOL_SETUP 캐릭터 "${characterName}" 생성 중 API 오류 발생:`, error);
        if (window.toastr) toastr.error(`캐릭터 '${characterName}' 생성 중 오류: ${error.message || error}`);
        return false;
    }
}

/**
 * QuickReply API를 안전하게 가져옵니다.
 * @returns {object|null} QuickReply API 객체 또는 실패 시 null
 */
function getQuickReplyApi() {
    if (!window.quickReplyApi) {
        console.error(`DB_TOOL_SETUP QuickReply API를 찾을 수 없습니다. QuickReply 확장이 설치 및 활성화되어 있는지 확인해주세요.`);
        if (window.toastr) toastr.error('QuickReply API를 사용할 수 없습니다. 관련 확장을 확인해주세요.');
        return null;
    }
    return window.quickReplyApi;
}

/**
 * 활성화된 첫 번째 전역 Quick Reply 세트의 이름을 가져옵니다.
 * @returns {string|null} 세트 이름 또는 찾지 못한 경우 null
 */
function getFirstActiveGlobalQuickReplySetName() {
    const quickReplyApi = getQuickReplyApi();
    if (!quickReplyApi || !quickReplyApi.settings || !quickReplyApi.settings.config || !Array.isArray(quickReplyApi.settings.config.setList)) {
        return null;
    }

    const setList = quickReplyApi.settings.config.setList;
    const firstActiveSetItem = setList.find(item => item && item.isVisible === true);

    if (firstActiveSetItem && firstActiveSetItem.set && typeof firstActiveSetItem.set.name === 'string' && firstActiveSetItem.set.name.trim() !== '') {
        return firstActiveSetItem.set.name;
    } else {
        if (window.toastr && !firstActiveSetItem) toastr.info("활성화된 전역 Quick Reply 세트가 없습니다. QR 생성을 위해 먼저 세트를 활성화해주세요.");
        else if (window.toastr) toastr.warning("활성 QR 세트는 찾았으나, 유효한 이름이 없습니다.");
        return null;
    }
}

/**
 * 지정된 Quick Reply 세트에 특정 레이블의 QR이 존재하는지 확인하고, 없으면 생성합니다.
 * @param {string} setName - QR 세트의 이름
 * @param {string} qrLabel - 생성하거나 확인할 QR의 레이블
 * @param {string} qrCommandString - QR에 설정할 명령어 문자열
 * @param {string} qrTitle - QR에 설정할 제목 (툴팁 등)
 * @returns {Promise<boolean>} QR이 준비되었는지 (존재하거나 성공적으로 생성되었는지) 여부
 */
async function ensureQuickReplyExists(setName, qrLabel, qrCommandString, qrTitle) {
    const quickReplyApi = getQuickReplyApi();
    if (!quickReplyApi) return false;

    let qrExists = !!quickReplyApi.getQrByLabel(setName, qrLabel);

    if (qrExists) {
        return true;
    }

    const qrProperties = {
        message: qrCommandString,
        icon: '',
        showLabel: false,
        title: qrTitle,
        isHidden: false,
        executeOnStartup: false,
        executeOnUser: false,
        executeOnAi: false,
        executeOnChatChange: false,
        executeOnGroupMemberDraft: false,
        executeOnNewChat: false,
        automationId: '',
    };

    try {
        quickReplyApi.createQuickReply(setName, qrLabel, qrProperties);
        if (window.toastr) toastr.info(`QR '${qrLabel}'이(가) 세트 '${setName}'에 생성되었습니다.`);
        return true;
    } catch (error) {
        console.error(`DB_TOOL_SETUP QR '${qrLabel}' 생성 중 오류:`, error);
        if (window.toastr) toastr.error(`QR '${qrLabel}' 생성 중 오류가 발생했습니다: ${error.message}`);
        return false;
    }
}

/**
 * 지정된 이름의 캐릭터가 존재하는지 확인하고, 없으면 생성합니다.
 * @param {string} characterName - 확인할 캐릭터의 이름
 * @param {string} firstMessage - 캐릭터 생성 시 사용할 첫 번째 메시지
 * @returns {Promise<boolean>} 캐릭터가 준비되었는지 (존재하거나 성공적으로 생성되었는지) 여부
 */
async function ensureCharacterExists(characterName, firstMessage) {
    let charExists = doesCharacterExist(characterName);

    if (charExists) {
        return true;
    }

    if (window.toastr) toastr.info(`필요한 캐릭터 '${characterName}'을(를) 찾을 수 없습니다. 생성을 시도합니다...`);

    const creationSuccess = await createSillyTavernCharacter(characterName, firstMessage);
    if (creationSuccess) {
        return true;
    } else {
        return false;
    }
}

/**
 * LLM 번역 DB 관리를 위한 QR과 캐릭터를 준비(확인 및 생성)합니다.
 * 이 함수는 사용자가 버튼을 클릭했을 때 호출됩니다.
 */
async function prepareQrAndCharacterForDbManagement() {
    const targetCharName = "llm번역DB백업용";
    const targetCharFirstMessage = `LLM 번역 DB 관리 캐릭터입니다. 다음 명령어를 사용할 수 있습니다:\n\n채팅 백업(업로드)\n/llmDBUploadBackup\n\n채팅 복원(다운로드+등록된 DB삭제)\n/llmDBDownloadRestore | /llmDBmetaClearBackup`;

    const qrLabel = 'llm번역DB관리';
    const qrTitle = 'LLM 번역 DB 관리';
    const qrCommandString = `
/let mainMenu {:
    /buttons labels=["(업로드)백업", "(다운로드)복원"] -LLM 번역 DB 관리-<br><br>어떤 작업을 하시겠습니까? |
    /let choice {{pipe}} |

    /if left={{var::choice}} right="(업로드)백업" rule=eq /:llmDBUpload |
    /if left={{var::choice}} right="(다운로드)복원" rule=eq /:llmDBDownload |
    /if left={{var::choice}} right="" rule=eq {: /abort :} |
    /:mainMenu | 
:} |

/let llmDBUpload {:
    /go ${targetCharName} | /delay 1000 | /llmDBUploadBackup |
    /abort |
:} |

/let llmDBDownload {:
    /go ${targetCharName} | /llmDBDownloadRestore | /llmDBmetaClearBackup |
    /abort |
:} |

/:mainMenu |
    `.trim();

    try {
        const activeQrSetName = getFirstActiveGlobalQuickReplySetName();
        if (!activeQrSetName) {
            if (window.toastr) toastr.error("활성화된 전역 QR 세트를 찾을 수 없습니다. QR 관련 작업을 진행할 수 없습니다.");
            return;
        }

        const quickReplyApi = getQuickReplyApi(); // API 한번만 호출
        const initialQrExists = quickReplyApi ? !!quickReplyApi.getQrByLabel(activeQrSetName, qrLabel) : false;
        const initialCharExists = doesCharacterExist(targetCharName);

        let qrReady = await ensureQuickReplyExists(activeQrSetName, qrLabel, qrCommandString, qrTitle);
        let charReady = await ensureCharacterExists(targetCharName, targetCharFirstMessage);

        let qrCreatedThisTime = qrReady && !initialQrExists;
        let charCreatedThisTime = charReady && !initialCharExists;
        let actionTakenThisTime = qrCreatedThisTime || charCreatedThisTime;

        if (qrReady && charReady) {
            if (actionTakenThisTime) {
                let message = "DB 관리 기능 설정 진행: ";
                if (qrCreatedThisTime && charCreatedThisTime) message += `QR '${qrLabel}' 및 캐릭터 '${targetCharName}'이(가) 준비되었습니다.`;
                else if (qrCreatedThisTime) message += `QR '${qrLabel}'이(가) 준비되었습니다.`;
                else if (charCreatedThisTime) message += `캐릭터 '${targetCharName}'이(가) 준비되었습니다.`;
                message += " 버튼을 다시 클릭하여 작업을 시작하세요.";
                if (window.toastr) toastr.success(message);
            } else {
                const readyMessage = `DB 관리 기능('${qrLabel}' QR, '${targetCharName}' 캐릭터) 사용 준비가 완료되었습니다. 버튼을 다시 클릭하여 작업을 시작하세요.`;
                if (window.toastr) toastr.info(readyMessage);
            }
        } else {
            let failMessage = "DB 관리 기능 설정 실패: ";
            if (!qrReady) failMessage += `QR '${qrLabel}' 준비에 실패했습니다. `;
            if (!charReady) failMessage += `캐릭터 '${targetCharName}' 준비에 실패했습니다.`;
            if (window.toastr) toastr.error(failMessage);
            console.error(`DB_TOOL_SETUP ${failMessage}`);
        }

    } catch (ex) {
        console.error(`DB 관리 기능 준비 중 예외 발생 ('${qrLabel}'):`, ex);
        if (window.toastr) toastr.error(`작업 중 오류가 발생했습니다: ${ex.message}`);
    }
}

//----------v3 end
/**
 * 연속된 백틱을 하나로 줄이고, 홀수 개의 백틱이 있을 경우 마지막에 백틱을 추가합니다.
 * (코드 블록 깨짐 방지 목적)
 * @param {string} input - 처리할 문자열
 * @returns {string} 처리된 문자열
 */
function correctBackticks(input) {
    // 입력값이 문자열이 아니거나 비어있으면 그대로 반환
    if (typeof input !== 'string' || input === null) {
        return input;
    }

    // 연속된 백틱을 하나로 줄이는 처리
    let correctedInput = input.replace(/`{2,}/g, '`');

    // 백틱(`)의 개수를 셈
    const backtickCount = (correctedInput.match(/`/g) || []).length;

    // 백틱이 홀수개일 경우
    if (backtickCount % 2 !== 0) {
        // 문자열의 끝에 백틱 추가 (단, 이미 백틱으로 끝나면 짝수를 위해 하나 더 붙임)
        correctedInput += '`';
    }

    // 백틱이 짝수개일 경우 원본(연속 백틱 처리된) 그대로 반환
    return correctedInput;
}


/**
 * 번역된 텍스트를 설정에 따라 가공합니다. (Display Mode: disabled, folded, original_first, unfolded)
 * - disabled: 원본 번역 텍스트를 그대로 반환합니다.
 * - folded: Placeholder 방식으로 특수 블록을 처리하고, 라인별 <details>/<summary> HTML을 생성합니다. (번역문 먼저 표시)
 * - original_first: Placeholder 방식으로 특수 블록을 처리하고, 라인별 <details>/<summary> HTML을 생성합니다. (원문 먼저 표시)
 * - unfolded: Placeholder 방식으로 특수 블록을 처리하고, 라인별 번역/원문 쌍 HTML을 생성합니다.
 * 오류 발생 시 또는 Fallback 시 적절한 출력을 반환합니다.
 * @param {string} originalText - 원본 메시지 텍스트 (HTML 포함 가능)
 * @param {string} translatedText - 번역된 텍스트 (HTML 포함 가능)
 * @returns {string} 가공된 HTML 문자열 또는 원본 번역 텍스트
 */
function processTranslationText(originalText, translatedText) {
    const displayMode = extensionSettings.translation_display_mode || 'disabled'; // 설정값 읽기 (기본값 'disabled')

    // 1. 'disabled' 모드 처리 (가장 먼저 확인)
    if (displayMode === 'disabled') {
        // translatedText가 null/undefined일 경우 빈 문자열 반환
        return translatedText || '';
    }

    // 2. 'folded', 'original_first' 또는 'unfolded' 모드를 위한 공통 처리 시작
    // translatedText가 null, undefined, 또는 빈 문자열이면 빈 문자열 반환 (disabled 모드 외)
    if (!translatedText) {
        return '';
    }

    try {
        // 3. 특수 블록 패턴 정의 및 Placeholder 준비
        const specialBlockRegexes = [
            /<think>[\s\S]*?<\/think>/gi,
            /<thinking>[\s\S]*?<\/thinking>/gi,
            /<tableEdit>[\s\S]*?<\/tableEdit>/gi,
            /<details[^>]*>[\s\S]*?<\/details>/gi,
            /`{3,}[^`]*[\s\S]*?`{3,}/g  // 3개 이상의 백틱, non-greedy
        ];

        // Font Manager의 커스텀 태그를 동적으로 추가
        try {
            const fontManagerSettings = localStorage.getItem('font-manager-settings');

            if (fontManagerSettings) {
                const parsedSettings = JSON.parse(fontManagerSettings);

                // 현재 프리셋 찾기
                const currentPresetId = parsedSettings?.currentPreset;
                const presets = parsedSettings?.presets || [];
                const currentPreset = presets.find(p => p.id === currentPresetId);

                // 프리셋의 customTags 우선, 없으면 전역 customTags
                const customTags = currentPreset?.customTags ?? parsedSettings?.customTags ?? [];

                // 각 커스텀 태그에 대한 정규식 추가
                customTags.forEach(tag => {
                    if (tag.tagName) {
                        const escapedTagName = tag.tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        const tagRegex = new RegExp(`<${escapedTagName}[^>]*>([\\s\\S]*?)</${escapedTagName}>`, 'gi');
                        specialBlockRegexes.push(tagRegex);
                    }
                });
            }
        } catch (error) {
            console.error('[LLM-Translator] Failed to load Font Manager custom tags:', error);
        }

        const placeholderPrefix = '__LLM_TRANSLATOR_SPECIAL_BLOCK_';
        const placeholderSuffix = '__';
        const placeholderRegexGlobal = new RegExp(placeholderPrefix + '\\d+' + placeholderSuffix, 'g');
        const placeholderRegexSingle = new RegExp('^' + placeholderPrefix + '\\d+' + placeholderSuffix + '$');
        const specialBlocksMap = {};
        let placeholderIndex = 0;
        let textWithPlaceholders = originalText || '';

        // console.log(`${DEBUG_PREFIX} Defined Special Block Regexes:`, specialBlockRegexes.map(r => r.toString()));

        // 4. 특수 블록 추출 및 Placeholder 삽입
        specialBlockRegexes.forEach(regex => {
            textWithPlaceholders = textWithPlaceholders.replace(regex, (match) => {
                const placeholder = `${placeholderPrefix}${placeholderIndex}${placeholderSuffix}`;
                specialBlocksMap[placeholder] = match;
                placeholderIndex++;
                return placeholder;
            });
        });

        // 번역문도 같은 방식으로 placeholder 처리
        let translatedWithPlaceholders = translatedText || '';
        let translatedPlaceholderIndex = 0;
        const translatedBlocksMap = {};

        specialBlockRegexes.forEach(regex => {
            translatedWithPlaceholders = translatedWithPlaceholders.replace(regex, (match) => {
                const placeholder = `${placeholderPrefix}TRANSLATED_${translatedPlaceholderIndex}${placeholderSuffix}`;
                translatedBlocksMap[placeholder] = match;
                translatedPlaceholderIndex++;
                return placeholder;
            });
        });

        // 5. 텍스트 전처리 (<br> -> \n, trim)
        let processedTextWithPlaceholders = (textWithPlaceholders || '').replace(/<br\s*\/?>/gi, '\n').trim();
        let processedTranslated = (translatedWithPlaceholders || '').replace(/<br\s*\/?>/gi, '\n').trim();
        let proseOnlyOriginalText = processedTextWithPlaceholders.replace(placeholderRegexGlobal, '').trim();

        // 번역문에서도 placeholder 제거하여 순수 텍스트만 추출
        const translatedPlaceholderRegex = new RegExp(placeholderPrefix + 'TRANSLATED_\\d+' + placeholderSuffix, 'g');
        const translatedPlaceholderRegexSingle = new RegExp('^' + placeholderPrefix + 'TRANSLATED_\\d+' + placeholderSuffix + '$');
        let proseOnlyTranslatedText = processedTranslated.replace(translatedPlaceholderRegex, '').trim();

        // 6. 라인 분리 및 정리
        const templateLines = processedTextWithPlaceholders.split('\n').map(line => line.trim());
        const translatedTemplateLines = processedTranslated.split('\n').map(line => line.trim()); // 번역문 템플릿 라인
        const proseOriginalLines = proseOnlyOriginalText.split('\n').map(line => line.trim()).filter(line => line !== '');
        const translatedLines = proseOnlyTranslatedText.split('\n').map(line => line.trim()).filter(line => line !== '');

        // 7. 라인 수 일치 확인 및 처리 경로 분기
        const forceSequentialMatching = extensionSettings.force_sequential_matching;
        const canProcessLineByLine = (proseOriginalLines.length === translatedLines.length && proseOriginalLines.length > 0) ||
            (forceSequentialMatching && (proseOriginalLines.length > 0 || translatedLines.length > 0));

        if (canProcessLineByLine) {
            // 7a. 성공 경로: 라인 수 일치 (본문 라인 1개 이상)

            // 순차 매칭 사용시 토스트 표시
            if (forceSequentialMatching && proseOriginalLines.length !== translatedLines.length && proseOriginalLines.length > 0 && translatedLines.length > 0) {
                toastr.info('번역문과 원문의 내용 단락 수가 일치하지 않아 순서대로 표시합니다.');
            }

            const resultHtmlParts = [];
            let proseLineIndex = 0;

            for (let i = 0; i < templateLines.length; i++) {
                const templateLine = templateLines[i];
                const translatedTemplateLine = translatedTemplateLines[i];

                if (placeholderRegexSingle.test(templateLine) && translatedPlaceholderRegexSingle.test(translatedTemplateLine)) {
                    // Placeholder를 details 구조로 감싸기
                    const originalBlock = specialBlocksMap[templateLine];
                    const translatedBlock = translatedBlocksMap[translatedTemplateLine];

                    // 코드 블록인 경우 (백틱으로 시작) - details 구조 없이 그대로 표시
                    const isCodeBlock = originalBlock.trim().startsWith('```');

                    if (isCodeBlock) {
                        // 코드 블록은 번역하지 않고 원본만 표시
                        resultHtmlParts.push(originalBlock);
                    } else {
                        // 일반 특수 블록은 details 구조로 감싸기
                        let blockHTML = '';
                        if (displayMode === 'folded') {
                            blockHTML =
                                '<details class="llm-translator-details mode-folded">' +
                                '<summary class="llm-translator-summary">' +
                                '<span class="translated_text clickable-text-org">' + translatedBlock + '</span>' +
                                '</summary>' +
                                '<span class="original_text">' + originalBlock + '</span>' +
                                '</details>';
                        } else if (displayMode === 'original_first') {
                            blockHTML =
                                '<details class="llm-translator-details mode-original-first">' +
                                '<summary class="llm-translator-summary">' +
                                '<span class="original_text clickable-text-org">' + originalBlock + '</span>' +
                                '</summary>' +
                                '<span class="translated_text">' + translatedBlock + '</span>' +
                                '</details>';
                        } else { // unfolded 모드
                            blockHTML =
                                '<span class="translated_text mode-unfolded">' + translatedBlock + '</span>' +
                                '<br>' +
                                '<span class="original_text mode-unfolded">' + originalBlock + '</span>';
                        }
                        resultHtmlParts.push(blockHTML);
                    }
                } else if (templateLine === '') {
                    // 빈 라인 유지
                    resultHtmlParts.push('');
                    // console.log(`${DEBUG_PREFIX} Reconstructing: Empty line preserved`);
                } else {
                    // 본문 라인 처리
                    if (forceSequentialMatching) {
                        // 순차 매칭 모드: 원문과 번역문을 순차적으로 매칭
                        const hasOriginal = proseLineIndex < proseOriginalLines.length;
                        const hasTranslated = proseLineIndex < translatedLines.length;

                        if (hasOriginal && hasTranslated) {
                            // 둘 다 있는 경우: 정상 매칭
                            const originalProseLine = proseOriginalLines[proseLineIndex];
                            const translatedLine = translatedLines[proseLineIndex];
                            const correctedTranslatedLine = correctBackticks(translatedLine);

                            let blockHTML = '';
                            if (displayMode === 'folded') {
                                blockHTML =
                                    '<details class="llm-translator-details mode-folded">' +
                                    '<summary class="llm-translator-summary">' +
                                    '<span class="translated_text clickable-text-org">' + correctedTranslatedLine + '</span>' +
                                    '</summary>' +
                                    '<span class="original_text">' + originalProseLine + '</span>' +
                                    '</details>';
                            } else if (displayMode === 'original_first') {
                                blockHTML =
                                    '<details class="llm-translator-details mode-original-first">' +
                                    '<summary class="llm-translator-summary">' +
                                    '<span class="original_text clickable-text-org">' + originalProseLine + '</span>' +
                                    '</summary>' +
                                    '<span class="translated_text">' + correctedTranslatedLine + '</span>' +
                                    '</details>';
                            } else { // unfolded 모드
                                blockHTML =
                                    '<span class="translated_text mode-unfolded">' + correctedTranslatedLine + '</span>' +
                                    '<br>' +
                                    '<span class="original_text mode-unfolded">' + originalProseLine + '</span>';
                            }
                            resultHtmlParts.push(blockHTML);
                            proseLineIndex++;
                        } else if (hasOriginal && !hasTranslated) {
                            // 원문만 남은 경우: 원문만 표시
                            const originalProseLine = proseOriginalLines[proseLineIndex];
                            resultHtmlParts.push('<span class="original_text">' + originalProseLine + '</span>');
                            proseLineIndex++;
                        } else if (!hasOriginal && hasTranslated) {
                            // 번역문만 남은 경우: 번역문만 표시
                            const translatedLine = translatedLines[proseLineIndex];
                            const correctedTranslatedLine = correctBackticks(translatedLine);
                            resultHtmlParts.push('<span class="translated_text">' + correctedTranslatedLine + '</span>');
                            proseLineIndex++;
                        } else {
                            // 둘 다 없는 경우: 건너뛰기
                        }
                    } else {
                        // 기존 모드: 라인 수가 정확히 일치해야 함
                        if (proseLineIndex < proseOriginalLines.length) {
                            const originalProseLine = proseOriginalLines[proseLineIndex];
                            const translatedLine = translatedLines[proseLineIndex];
                            const correctedTranslatedLine = correctBackticks(translatedLine);

                            let blockHTML = '';
                            if (displayMode === 'folded') {
                                blockHTML =
                                    '<details class="llm-translator-details mode-folded">' +
                                    '<summary class="llm-translator-summary">' +
                                    '<span class="translated_text clickable-text-org">' + correctedTranslatedLine + '</span>' +
                                    '</summary>' +
                                    '<span class="original_text">' + originalProseLine + '</span>' +
                                    '</details>';
                            } else if (displayMode === 'original_first') {
                                blockHTML =
                                    '<details class="llm-translator-details mode-original-first">' +
                                    '<summary class="llm-translator-summary">' +
                                    '<span class="original_text clickable-text-org">' + originalProseLine + '</span>' +
                                    '</summary>' +
                                    '<span class="translated_text">' + correctedTranslatedLine + '</span>' +
                                    '</details>';
                            } else { // unfolded 모드
                                blockHTML =
                                    '<span class="translated_text mode-unfolded">' + correctedTranslatedLine + '</span>' +
                                    '<br>' +
                                    '<span class="original_text mode-unfolded">' + originalProseLine + '</span>';
                            }
                            resultHtmlParts.push(blockHTML);
                            proseLineIndex++;
                        } else {
                            // console.warn(`${DEBUG_PREFIX} Mismatch warning: Skipping template line:`, templateLine);
                        }
                    }
                }
            }

            // 순차 매칭 모드에서 남은 라인들 처리
            if (forceSequentialMatching) {
                const maxLines = Math.max(proseOriginalLines.length, translatedLines.length);

                // template 기반 매칭 후 남은 라인들을 순차적으로 처리
                for (let i = proseLineIndex; i < maxLines; i++) {
                    const hasOriginal = i < proseOriginalLines.length;
                    const hasTranslated = i < translatedLines.length;

                    if (hasOriginal && hasTranslated) {
                        // 둘 다 있는 경우: 정상 매칭
                        const originalProseLine = proseOriginalLines[i];
                        const translatedLine = translatedLines[i];
                        const correctedTranslatedLine = correctBackticks(translatedLine);

                        let blockHTML = '';
                        if (displayMode === 'folded') {
                            blockHTML =
                                '<details class="llm-translator-details mode-folded">' +
                                '<summary class="llm-translator-summary">' +
                                '<span class="translated_text clickable-text-org">' + correctedTranslatedLine + '</span>' +
                                '</summary>' +
                                '<span class="original_text">' + originalProseLine + '</span>' +
                                '</details>';
                        } else if (displayMode === 'original_first') {
                            blockHTML =
                                '<details class="llm-translator-details mode-original-first">' +
                                '<summary class="llm-translator-summary">' +
                                '<span class="original_text clickable-text-org">' + originalProseLine + '</span>' +
                                '</summary>' +
                                '<span class="translated_text">' + correctedTranslatedLine + '</span>' +
                                '</details>';
                        } else { // unfolded 모드
                            blockHTML =
                                '<span class="translated_text mode-unfolded">' + correctedTranslatedLine + '</span>' +
                                '<br>' +
                                '<span class="original_text mode-unfolded">' + originalProseLine + '</span>';
                        }
                        resultHtmlParts.push(blockHTML);
                    } else if (hasOriginal && !hasTranslated) {
                        // 원문만 남은 경우
                        const originalProseLine = proseOriginalLines[i];
                        resultHtmlParts.push('<span class="original_text">' + originalProseLine + '</span>');
                    } else if (!hasOriginal && hasTranslated) {
                        // 번역문만 남은 경우
                        const translatedLine = translatedLines[i];
                        const correctedTranslatedLine = correctBackticks(translatedLine);
                        resultHtmlParts.push('<span class="translated_text">' + correctedTranslatedLine + '</span>');
                    }
                }
            }

            const finalHtmlResult = resultHtmlParts.join('\n').trim();
            return finalHtmlResult;

        } else {
            // 7b. Fallback 경로: 라인 수 불일치 또는 본문 라인 0개
            if (proseOriginalLines.length === 0 && translatedLines.length === 0 && templateLines.some(line => placeholderRegexSingle.test(line))) {
                // 특수 블록만 있는 경우: 원문/번역문 placeholder를 details로 변환

                const translatedTemplateLines = processedTranslated.split('\n').map(line => line.trim());
                const translatedPlaceholderRegexSingle = new RegExp('^' + placeholderPrefix + 'TRANSLATED_\\d+' + placeholderSuffix + '$');

                const resultHtmlParts = [];
                for (let i = 0; i < templateLines.length; i++) {
                    const origLine = templateLines[i];
                    const transLine = translatedTemplateLines[i];

                    if (placeholderRegexSingle.test(origLine) && transLine && translatedPlaceholderRegexSingle.test(transLine)) {
                        // 원문과 번역문 placeholder를 details로 변환
                        const originalBlock = specialBlocksMap[origLine];
                        const translatedBlock = translatedBlocksMap[transLine];

                        // 코드 블록인 경우 (백틱으로 시작) - details 구조 없이 그대로 표시
                        const isCodeBlock = originalBlock.trim().startsWith('```');

                        if (isCodeBlock) {
                            // 코드 블록은 details 없이 번역문 그대로 표시
                            resultHtmlParts.push(translatedBlock);
                        } else {
                            // 일반 특수 블록은 details 구조로 감싸기
                            let blockHTML = '';
                            if (displayMode === 'folded') {
                                blockHTML =
                                    '<details class="llm-translator-details mode-folded">' +
                                    '<summary class="llm-translator-summary">' +
                                    '<span class="translated_text clickable-text-org">' + translatedBlock + '</span>' +
                                    '</summary>' +
                                    '<span class="original_text">' + originalBlock + '</span>' +
                                    '</details>';
                            } else if (displayMode === 'original_first') {
                                blockHTML =
                                    '<details class="llm-translator-details mode-original-first">' +
                                    '<summary class="llm-translator-summary">' +
                                    '<span class="original_text clickable-text-org">' + originalBlock + '</span>' +
                                    '</summary>' +
                                    '<span class="translated_text">' + translatedBlock + '</span>' +
                                    '</details>';
                            } else { // unfolded
                                blockHTML =
                                    '<span class="translated_text mode-unfolded">' + translatedBlock + '</span>' +
                                    '<br>' +
                                    '<span class="original_text mode-unfolded">' + originalBlock + '</span>';
                            }
                            resultHtmlParts.push(blockHTML);
                        }
                    } else if (placeholderRegexSingle.test(origLine)) {
                        // 원문만 placeholder인 경우
                        resultHtmlParts.push(specialBlocksMap[origLine]);
                    } else {
                        // 일반 텍스트
                        resultHtmlParts.push(origLine);
                    }
                }

                const finalHtmlResult = resultHtmlParts.join('\n').trim();
                return finalHtmlResult;

            } else {
                // 일반 Fallback: 라인 수 불일치 등
                // console.warn(`${DEBUG_PREFIX} Line count mismatch or zero prose lines! Falling back to single block (${displayMode}).`); // 경고 로그 유지 가능
                if (proseOriginalLines.length !== translatedLines.length) {
                    if (forceSequentialMatching) {
                        toastr.info('번역문과 원문의 내용 단락 수가 일치하지 않아 순서대로 표시합니다.');
                    } else {
                        toastr.warning('번역문과 원문의 내용 단락 수가 일치하지 않아 전체를 하나로 표시합니다.');
                    }
                }

                const fallbackTranslated = correctBackticks(translatedText || ''); // 전체 번역 백틱 처리
                const fallbackOriginal = originalText || ''; // 전체 원본

                let fallbackHTML = '';
                if (displayMode === 'folded') {
                    // 접기 방식 Fallback
                    fallbackHTML =
                        '<details class="llm-translator-details mode-folded">' +
                        '<summary class="llm-translator-summary">' +
                        '<span class="translated_text clickable-text-org">' + fallbackTranslated + '</span>' +
                        '</summary>' +
                        '<span class="original_text">' + fallbackOriginal + '</span>' +
                        '</details>';
                } else if (displayMode === 'original_first') {
                    // 원문 먼저 보기 방식 Fallback
                    fallbackHTML =
                        '<details class="llm-translator-details mode-original-first">' +
                        '<summary class="llm-translator-summary">' +
                        '<span class="original_text clickable-text-org">' + fallbackOriginal + '</span>' +
                        '</summary>' +
                        '<span class="translated_text">' + fallbackTranslated + '</span>' +
                        '</details>';
                } else { // unfolded 모드 Fallback
                    // 펼침 방식 Fallback
                    fallbackHTML =
                        '<span class="translated_text mode-unfolded">' + fallbackTranslated + '</span>' +
                        '<br>' +
                        '<span class="original_text mode-unfolded">' + fallbackOriginal + '</span>';
                }
                // console.log(`${DEBUG_PREFIX} Fallback HTML Generated (${displayMode}):`, fallbackHTML);
                return fallbackHTML;
            }
        }

    } catch (error) {
        // 8. 오류 처리
        console.error(`${DEBUG_PREFIX} Error during processTranslationText (Mode: ${displayMode}):`, error); // 오류 로깅은 유지
        toastr.error('번역문 처리 중 오류가 발생했습니다. 가공된 번역문을 표시합니다.');
        // 오류 시에는 최소한 백틱 처리된 번역문이라도 반환 (disabled 모드가 아닐 때)
        return correctBackticks(translatedText || '');
    } finally {
        // console.log(`${DEBUG_PREFIX} processTranslationText END (Mode: ${displayMode})`);
    }
}














SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'LlmTranslateLast',
    callback: async () => {
        const lastMessage = document.querySelector('#chat .mes:last-child');
        let targetButton;
        if (lastMessage) {
            targetButton = lastMessage.querySelector('.mes_llm_translate');
            if (targetButton) {
                targetButton.click();
                return '마지막 메시지를 LLM으로 번역합니다.';
            } else {
                return '마지막 메시지 LLM 번역 버튼을 찾을 수 없습니다.';
            }
        } else {
            return '채팅 메시지가 없습니다.';
        }
    },
    helpString: '마지막 메시지를 LLM 번역기로 번역합니다.',
}));

SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'LlmRetranslateCorrection',
    callback: async (parsedArgs) => {
        const messageIdStr = validateAndNormalizeMessageId(parsedArgs.messageId);

        let actualMessageId = messageIdStr;
        if (messageIdStr === 'last') {
            const context = getContext();
            if (!context || !context.chat || context.chat.length === 0) {
                return '채팅 메시지가 없습니다.';
            }
            actualMessageId = context.chat.length - 1;
        }

        // 백그라운드에서 재번역 실행 (UI 블로킹 방지)
        retranslateMessage(actualMessageId, 'correction', true).catch(error => {
            console.error('Retranslation error:', error);
            toastr.error(`메시지 ID ${actualMessageId} 교정 재번역 중 오류가 발생했습니다.`);
        });

        return `메시지 ID ${actualMessageId} 교정 재번역을 시작했습니다.`;
    },
    helpString: '지정한 ID의 메시지를 교정 재번역합니다 (기존 번역문을 개선). messageId를 생략하면 마지막 메시지를 대상으로 합니다.\n사용법: /LlmRetranslateCorrection [messageId=<메시지ID>]',
    namedArgumentList: [
        SlashCommandNamedArgument.fromProps({
            name: 'messageId',
            description: '교정 재번역할 메시지의 ID 또는 "last" (마지막 메시지)',
            isRequired: false,
            defaultValue: '{{lastMessageId}}',
            typeList: [ARGUMENT_TYPE.STRING],
        }),
    ],
}));

SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'LlmRetranslateGuidance',
    callback: async (parsedArgs) => {
        const messageIdStr = validateAndNormalizeMessageId(parsedArgs.messageId);

        let actualMessageId = messageIdStr;
        if (messageIdStr === 'last') {
            const context = getContext();
            if (!context || !context.chat || context.chat.length === 0) {
                return '채팅 메시지가 없습니다.';
            }
            actualMessageId = context.chat.length - 1;
        }

        // 백그라운드에서 재번역 실행 (UI 블로킹 방지)
        retranslateMessage(actualMessageId, 'guidance', true).catch(error => {
            console.error('Retranslation error:', error);
            toastr.error(`메시지 ID ${actualMessageId} 지침교정 재번역 중 오류가 발생했습니다.`);
        });

        return `메시지 ID ${actualMessageId} 지침교정 재번역을 시작했습니다.`;
    },
    helpString: '지정한 ID의 메시지를 지침교정 재번역합니다 (추가 지침을 입력받아 번역문을 개선). messageId를 생략하면 마지막 메시지를 대상으로 합니다.\n사용법: /LlmRetranslateGuidance [messageId=<메시지ID>]',
    namedArgumentList: [
        SlashCommandNamedArgument.fromProps({
            name: 'messageId',
            description: '지침교정 재번역할 메시지의 ID 또는 "last" (마지막 메시지)',
            isRequired: false,
            defaultValue: '{{lastMessageId}}',
            typeList: [ARGUMENT_TYPE.STRING],
        }),
    ],
}));

SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'LlmRetranslateParagraph',
    callback: async (parsedArgs) => {
        const messageIdStr = validateAndNormalizeMessageId(parsedArgs.messageId);

        let actualMessageId = messageIdStr;
        if (messageIdStr === 'last') {
            const context = getContext();
            if (!context || !context.chat || context.chat.length === 0) {
                return '채팅 메시지가 없습니다.';
            }
            actualMessageId = context.chat.length - 1;
        }

        // 백그라운드에서 재번역 실행 (UI 블로킹 방지)
        retranslateMessage(actualMessageId, 'paragraph', true).catch(error => {
            console.error('Retranslation error:', error);
            toastr.error(`메시지 ID ${actualMessageId} 문단 구조 맞추기 재번역 중 오류가 발생했습니다.`);
        });

        return `메시지 ID ${actualMessageId} 문단 구조 맞추기 재번역을 시작했습니다.`;
    },
    helpString: '지정한 ID의 메시지를 문단 구조 맞추기 재번역합니다 (원문 구조에 맞춰 재번역). messageId를 생략하면 마지막 메시지를 대상으로 합니다.\n사용법: /LlmRetranslateParagraph [messageId=<메시지ID>]',
    namedArgumentList: [
        SlashCommandNamedArgument.fromProps({
            name: 'messageId',
            description: '문단 맞추기 재번역할 메시지의 ID 또는 "last" (마지막 메시지)',
            isRequired: false,
            defaultValue: '{{lastMessageId}}',
            typeList: [ARGUMENT_TYPE.STRING],
        }),
    ],
}));

SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'LlmTranslateID',
    callback: async (parsedArgs) => {
        const messageIdStr = validateAndNormalizeMessageId(parsedArgs.messageId);

        let actualMessageId = messageIdStr;
        if (messageIdStr === 'last') {
            const context = getContext();
            if (!context || !context.chat || context.chat.length === 0) {
                return '채팅 메시지가 없습니다.';
            }
            actualMessageId = context.chat.length - 1;
        }

        const messageId = parseInt(actualMessageId, 10);
        if (isNaN(messageId) || messageId < 0) {
            return `유효하지 않은 메시지 ID: "${actualMessageId}". 숫자를 입력하세요.`;
        }

        const context = getContext();
        if (!context || !context.chat) {
            return '컨텍스트 또는 채팅 데이터를 찾을 수 없습니다.';
        }
        if (messageId >= context.chat.length) {
            return `메시지 ID ${messageId}를 찾을 수 없습니다. (채팅 길이: ${context.chat.length})`;
        }

        // 백그라운드에서 번역 실행 (UI 블로킹 방지)
        translateMessage(messageId, true, 'LlmTranslateID_command').catch(error => {
            console.error('Translation error:', error);
            toastr.error(`메시지 ID ${messageId} 번역 중 오류가 발생했습니다.`);
        });

        // 즉시 성공 메시지 반환 (UI 블로킹 없음)
        return `메시지 ID ${messageId} 번역을 시작했습니다.`;
    },
    helpString: '지정한 ID의 메시지를 LLM 번역기로 번역합니다. messageId를 생략하면 마지막 메시지를 대상으로 합니다.\n사용법: /LlmTranslateID [messageId=<메시지ID>]',
    namedArgumentList: [
        SlashCommandNamedArgument.fromProps({
            name: 'messageId',
            description: '번역할 메시지의 ID 또는 "last" (마지막 메시지)',
            isRequired: false,
            defaultValue: '{{lastMessageId}}',
            typeList: [ARGUMENT_TYPE.STRING],
        }),
    ],
}));




SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'llmDBUploadBackup',
    callback: backupTranslationsToMetadata,
    helpString: 'LLM 번역 캐시를 현재 채팅 메타데이터에 백업합니다. (백업용 채팅에서 실행 권장)',
    returns: '백업 진행 및 결과 알림 (toastr)',
}));

SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'llmDBDownloadRestore',
    callback: restoreTranslationsFromMetadata, // Add-Only + Progress Bar 버전
    helpString: '현재 채팅 메타데이터의 백업에서 번역 캐시를 복원/병합합니다 (없는 데이터만 추가).',
    returns: '복원 진행(프로그레스 바) 및 결과 알림 (toastr)',
}));

SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'llmDBmetaClearBackup',
    callback: clearBackupFromMetadata,
    helpString: '현재 채팅 메타데이터에서 LLM 번역 캐시 백업을 삭제합니다 (영구 삭제).',
    returns: '삭제 확인 팝업 및 결과 알림 (toastr)',
}));

//	/llmGetTranslation messageId={{lastMessageId}}
SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    /**
     * 슬래시 커맨드 이름: /llmGetTranslation
     * 기능: 지정된 메시지 ID에 해당하는 번역문을 DB에서 가져옵니다.
     * 사용법: /llmGetTranslation messageId=<ID> 또는 /llmGetTranslation messageId=last
     */
    name: 'llmGetTranslation',
    /**
     * 호출될 콜백 함수: 객체(parsedArgs)를 인수로 받습니다.
     */
    callback: async (parsedArgs) => {
        const DEBUG_PREFIX_CMD = `[${extensionName} - Cmd /llmGetTranslation]`;
        logDebug(`${DEBUG_PREFIX_CMD} Executing with args:`, parsedArgs);

        let messageIdStr = validateAndNormalizeMessageId(parsedArgs.messageId);

        // 'last' 처리
        if (messageIdStr === 'last') {
            const context = getContext();
            if (!context || !context.chat || context.chat.length === 0) {
                return '오류: 채팅 메시지가 없습니다.';
            }
            messageIdStr = String(context.chat.length - 1); // 마지막 메시지 ID로 변환
            logDebug(`${DEBUG_PREFIX_CMD} 'last' converted to messageId: ${messageIdStr}`);
        }

        // getTranslationById 함수 호출
        return await getTranslationById(messageIdStr);
    },
    /**
     * 도움말: 사용자가 /help llmGetTranslation 을 입력했을 때 표시될 설명입니다.
     */
    helpString: '지정한 메시지 ID의 LLM 번역문을 DB에서 가져옵니다. messageId를 생략하면 마지막 메시지를 대상으로 합니다.\n사용법: /llmGetTranslation [messageId=<메시지ID>]',
    /**
     * 이름 기반 인수 정의: namedArgumentList 사용
     */
    namedArgumentList: [
        SlashCommandNamedArgument.fromProps({
            name: 'messageId',
            description: '번역문을 가져올 메시지의 숫자 ID 또는 "last" (마지막 메시지)',
            isRequired: false,
            defaultValue: '{{lastMessageId}}',
            typeList: [ARGUMENT_TYPE.STRING], // 'last'도 받을 수 있도록 STRING 타입
        }),
    ],
    /**
     * 반환값 설명: 콜백 함수의 반환값 유형에 대한 설명 (참고용).
     */
    returns: '번역문 또는 오류/정보 메시지',
}));

//	/llmDBDeleteTranslation messageId={{lastMessageId}}
SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    /**
     * 슬래시 커맨드 이름: /llmDBDeleteTranslation
     * 기능: 지정된 메시지 ID (및 선택적 스와이프 번호)에 해당하는 번역 데이터를 DB에서 삭제합니다.
     * 사용법: /llmDBDeleteTranslation messageId=<ID> [swipeNumber=<번호>]
     */
    name: 'llmDBDeleteTranslation', // 이름은 그대로 유지하거나 원하는 대로 변경 (예: llmDeleteTranslation)
    /**
     * 호출될 콜백 함수: 이제 객체(parsedArgs)를 인수로 받습니다.
     */
    callback: async (parsedArgs) => {
        const DEBUG_PREFIX_CMD = `[${extensionName} - Cmd /llmDBDeleteTranslation]`;
        logDebug(`${DEBUG_PREFIX_CMD} Executing with args:`, parsedArgs);

        // 객체에서 messageId와 swipeNumber 추출 (값이 문자열일 수 있음에 유의)
        const messageIdStr = validateAndNormalizeMessageId(parsedArgs.messageId);
        const swipeNumberStr = parsedArgs.swipeNumber; // optional이므로 undefined일 수 있음

        // deleteTranslationById 함수 호출 (이 함수는 내부적으로 문자열 ID를 숫자로 변환함)
        // swipeNumberStr가 undefined여도 deleteTranslationById 함수에서 처리 가능
        return await deleteTranslationById(messageIdStr, swipeNumberStr);
    },
    /**
     * 도움말: 사용자가 /help llmDBDeleteTranslation 을 입력했을 때 표시될 설명입니다.
     * 사용법 예시를 named argument 방식으로 수정합니다.
     */
    helpString: '지정한 메시지 ID (및 선택적 스와이프 번호)의 LLM 번역 기록(DB) 및 화면 표시를 삭제합니다. messageId를 생략하면 마지막 메시지를 대상으로 합니다.\n사용법: /llmDBDeleteTranslation [messageId=<메시지ID>] [swipeNumber=<스와이프번호>]',
    /**
     * 이름 기반 인수 정의: namedArgumentList 사용
     */
    namedArgumentList: [
        SlashCommandNamedArgument.fromProps({
            name: 'messageId', // 인수 이름 (예: messageId=123)
            description: '삭제할 번역이 있는 메시지의 숫자 ID',
            isRequired: false, // 필수 인수
            defaultValue: '{{lastMessageId}}',
            typeList: [ARGUMENT_TYPE.STRING], // 'last'도 받을 수 있도록 STRING 타입으로 변경
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'swipeNumber', // 인수 이름 (예: swipeNumber=2)
            description: '삭제할 스와이프 번호 (1부터 시작). 생략 시 현재 활성화된 스와이프/메시지 기준.',
            isRequired: false, // 선택적 인수
            typeList: [ARGUMENT_TYPE.INTEGER], // 예상 타입
            // defaultValue: undefined, // 기본값은 설정 안 함 (콜백에서 undefined 체크)
        }),
    ],
    /**
     * 반환값 설명: 콜백 함수의 반환값 유형에 대한 설명 (참고용).
     */
    returns: '삭제 작업 성공/실패/정보 메시지',
}));
// 기존 llmTranslate 수정: prompt 인수 추가
SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'llmTranslate',
    helpString: 'LLM을 사용하여 텍스트를 번역합니다. 기본적으로 채팅 번역 설정을 따르며, prompt 인수로 프롬프트를 직접 지정할 수 있습니다.\n사용법: /llmTranslate "텍스트" [prompt="프롬프트 내용"]',
    unnamedArgumentList: [
        new SlashCommandArgument('번역할 텍스트', ARGUMENT_TYPE.STRING, true, false, ''),
    ],
    namedArgumentList: [
        SlashCommandNamedArgument.fromProps({
            name: 'prompt',
            description: '사용할 커스텀 프롬프트 (생략 시 기본 채팅 번역 프롬프트 사용)',
            isRequired: false,
            typeList: [ARGUMENT_TYPE.STRING],
        })
    ],
    callback: async (args, value) => {
        // args.prompt가 있으면 그것을 사용, 없으면 함수 내부 기본값(llm_prompt_chat) 사용을 위해 undefined 전달
        const customPrompt = args.prompt || undefined;
        const textToTranslate = String(value);

        if (!textToTranslate.trim()) {
            return '번역할 텍스트를 입력해주세요.';
        }

        try {
            // translate 함수는 prompt 옵션이 없으면 기본적으로 llm_prompt_chat을 사용함
            const translatedText = await translate(textToTranslate, { prompt: customPrompt });
            return translatedText;
        } catch (error) {
            console.error('LLMTranslate Slash Command Error:', error);
            return `LLM 번역 중 오류 발생: ${error.message}`;
        }
    },
    returns: ARGUMENT_TYPE.STRING,
}));

// 신규 llmTranslateInput 추가: 입력 번역용
SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'llmTranslateInput',
    helpString: 'LLM을 사용하여 텍스트를 입력용(주로 영어)으로 번역합니다. 기본적으로 입력 번역 설정을 따르며, prompt 인수로 프롬프트를 직접 지정할 수 있습니다.\n사용법: /llmTranslateInput "텍스트" [prompt="프롬프트 내용"]',
    unnamedArgumentList: [
        new SlashCommandArgument('번역할 텍스트', ARGUMENT_TYPE.STRING, true, false, ''),
    ],
    namedArgumentList: [
        SlashCommandNamedArgument.fromProps({
            name: 'prompt',
            description: '사용할 커스텀 프롬프트 (생략 시 기본 입력 번역 프롬프트 사용)',
            isRequired: false,
            typeList: [ARGUMENT_TYPE.STRING],
        })
    ],
    callback: async (args, value) => {
        // args.prompt가 있으면 사용, 없으면 설정의 입력 번역 프롬프트 사용
        const inputPrompt = args.prompt || extensionSettings.llm_prompt_input || 'Please translate the following text to english:';
        const textToTranslate = String(value);

        if (!textToTranslate.trim()) {
            return '번역할 텍스트를 입력해주세요.';
        }

        try {
            // isInputTranslation: true를 전달하여 컨텍스트 처리(마지막 메시지 제외 등)가 입력 번역에 맞게 동작하도록 함
            const translatedText = await translate(textToTranslate, { 
                prompt: inputPrompt,
                isInputTranslation: true 
            });
            return translatedText;
        } catch (error) {
            console.error('LLMTranslateInput Slash Command Error:', error);
            return `LLM 입력 번역 중 오류 발생: ${error.message}`;
        }
    },
    returns: ARGUMENT_TYPE.STRING,
}));

// 범위 지정 번역문 가져오기 커맨드
SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'llmGetTranslations',
    callback: async (parsedArgs) => {
        const DEBUG_PREFIX_CMD = `[${extensionName} - Cmd /llmGetTranslations]`;
        logDebug(`${DEBUG_PREFIX_CMD} Executing with args:`, parsedArgs);

        let startIdStr = parsedArgs.startId || '0';
        let endIdStr = parsedArgs.endId || '{{lastMessageId}}';
        const includeOriginal = parsedArgs.includeOriginal === 'true'; // 기본값은 false
        const includeMessageId = parsedArgs.includeMessageId === 'true'; // 기본값은 false
        const excludeHidden = parsedArgs.excludeHidden !== 'false'; // 기본값은 true

        // 'last' 및 매크로 처리
        if (endIdStr === '{{lastMessageId}}' || endIdStr === 'last') {
            const context = getContext();
            if (!context || !context.chat || context.chat.length === 0) {
                return '오류: 채팅 메시지가 없습니다.';
            }
            endIdStr = String(context.chat.length - 1);
            logDebug(`${DEBUG_PREFIX_CMD} 'last' converted to endId: ${endIdStr}`);
        }

        if (startIdStr === 'last') {
            const context = getContext();
            if (!context || !context.chat || context.chat.length === 0) {
                return '오류: 채팅 메시지가 없습니다.';
            }
            startIdStr = String(context.chat.length - 1);
            logDebug(`${DEBUG_PREFIX_CMD} 'last' converted to startId: ${startIdStr}`);
        }

        // getTranslationsInRange 함수 호출
        return await getTranslationsInRange(startIdStr, endIdStr, includeOriginal, includeMessageId, excludeHidden);
    },
    helpString: '지정한 범위의 메시지들의 번역문을 가져옵니다. 기본적으로 번역문만 ID 없이 출력하고 숨겨진 메시지는 제외합니다.\n사용법: /llmGetTranslations [startId=<시작ID>] [endId=<종료ID>] [includeOriginal=true/false] [includeMessageId=true/false] [excludeHidden=true/false]',
    namedArgumentList: [
        SlashCommandNamedArgument.fromProps({
            name: 'startId',
            description: '시작 메시지 ID (기본값: 0)',
            isRequired: false,
            defaultValue: '0',
            typeList: [ARGUMENT_TYPE.STRING],
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'endId',
            description: '종료 메시지 ID (기본값: 마지막 메시지)',
            isRequired: false,
            defaultValue: '{{lastMessageId}}',
            typeList: [ARGUMENT_TYPE.STRING],
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'includeOriginal',
            description: '번역문이 없을 때 원문 포함 여부 (기본값: false)',
            isRequired: false,
            defaultValue: 'false',
            typeList: [ARGUMENT_TYPE.STRING],
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'includeMessageId',
            description: '메시지 ID 출력 여부 (기본값: false)',
            isRequired: false,
            defaultValue: 'false',
            typeList: [ARGUMENT_TYPE.STRING],
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'excludeHidden',
            description: '숨겨진 메시지 제외 여부 (기본값: true)',
            isRequired: false,
            defaultValue: 'true',
            typeList: [ARGUMENT_TYPE.STRING],
        }),
    ],
    returns: '범위 내 번역문들을 연결한 텍스트',
}));


logDebug('Slash Commands registered successfully.');

// 프롬프트 관리를 위한 클래스 정의
class PromptManager {
    constructor() {
        this.customPrompts = [];
        this.loadFromSettings();
        this.initializeEventListeners();
    }

    loadFromSettings() {
        this.customPrompts = extensionSettings.customPrompts || [];
        this.updatePromptDropdown();

        // 저장된 선택 프롬프트 복원
        const savedPromptId = extensionSettings.selected_translation_prompt_id;
        if (savedPromptId) {
            const selectedPrompt = this.customPrompts.find(p => p.id === savedPromptId);
            if (selectedPrompt) {
                extensionSettings.selected_translation_prompt = selectedPrompt.content;
                logDebug('Loaded saved prompt:', selectedPrompt.title);
            }
        }
    }

    initializeEventListeners() {
        // 프롬프트 추가/삭제 버튼 이벤트 리스너
        $(document).off('click', '#addPromptBtn').on('click', '#addPromptBtn', () => {
            this.showAddPromptDialog();
        });

        $(document).off('click', '#deletePromptBtn').on('click', '#deletePromptBtn', () => {
            this.deleteSelectedPrompt();
        });

        // 프롬프트 선택 이벤트 리스너 (번역용 + 편집기 로드)
        $(document).off('change', '#prompt_select').on('change', '#prompt_select', () => {
            const promptSelect = document.getElementById('prompt_select');
            const selectedId = promptSelect.value;

            // 편집기에 선택된 프롬프트 로드
            this.loadPromptToEditor();

            // 번역용 프롬프트 설정 (커스텀 프롬프트인 경우)
            const customPrompt = this.customPrompts.find(p => p.id === selectedId);
            if (customPrompt) {
                extensionSettings.selected_translation_prompt_id = selectedId;
                extensionSettings.selected_translation_prompt = customPrompt.content;
                logDebug('Selected translation prompt:', customPrompt.title, customPrompt.content);
            } else {
                // 기본 프롬프트 선택 시 초기화
                extensionSettings.selected_translation_prompt_id = null;
                extensionSettings.selected_translation_prompt = null;
                logDebug('Using default translation prompt:', selectedId);
            }
            saveSettingsDebounced();
        });



        // 프롬프트 저장 버튼 이벤트 리스너
        $(document).off('click', '#prompt_save_button').on('click', '#prompt_save_button', () => {
            this.saveCurrentPrompt();
        });
    }

    updatePromptDropdown() {
        // 통합 프롬프트 선택 드롭다운 업데이트
        const promptSelect = document.getElementById('prompt_select');
        if (!promptSelect) return;

        // 현재 선택된 값 저장
        const currentValue = promptSelect.value;

        // 기존 옵션들 제거
        promptSelect.innerHTML = '';

        // 1. 채팅 번역 프롬프트 (메인 프롬프트)
        const mainOption = document.createElement('option');
        mainOption.value = 'llm_prompt_chat';
        mainOption.textContent = '채팅 번역 프롬프트';
        promptSelect.appendChild(mainOption);

        // 2. 커스텀 프롬프트들 추가
        this.customPrompts.forEach(prompt => {
            const option = document.createElement('option');
            option.value = prompt.id;
            option.textContent = prompt.title;
            promptSelect.appendChild(option);
        });

        // 3. 구분선 (disabled option)
        if (this.customPrompts.length > 0) {
            const separator = document.createElement('option');
            separator.disabled = true;
            separator.textContent = '─────────────────';
            promptSelect.appendChild(separator);
        }

        // 4. 유틸리티 프롬프트들 (맨 아래)
        const utilityPrompts = [
            { value: 'llm_prompt_retranslate_correction', text: '⚙️ 재번역 (교정) 프롬프트' },
            { value: 'llm_prompt_retranslate_guidance', text: '⚙️ 재번역 (지침교정) 프롬프트' },
            { value: 'llm_prompt_retranslate_paragraph', text: '⚙️ 재번역 (문단 수 맞추기) 프롬프트' },
            { value: 'llm_prompt_input', text: '⚙️ 입력 번역 프롬프트' },
            { value: 'llm_prefill_content', text: '⚙️ 프리필' }
        ];

        utilityPrompts.forEach(prompt => {
            const option = document.createElement('option');
            option.value = prompt.value;
            option.textContent = prompt.text;
            promptSelect.appendChild(option);
        });

        // 이전 선택값 복원 또는 기본값 설정
        const valueExists = Array.from(promptSelect.options).some(opt => opt.value === currentValue && !opt.disabled);
        if (valueExists && currentValue) {
            promptSelect.value = currentValue;
        } else {
            promptSelect.value = 'llm_prompt_chat';
        }

        // 편집기에 현재 선택된 프롬프트 로드
        this.loadPromptToEditor();
    }

    loadPromptToEditor() {
        const promptSelect = document.getElementById('prompt_select');
        const promptEditor = document.getElementById('llm_prompt_editor');

        if (!promptSelect || !promptEditor) return;

        const selectedValue = promptSelect.value;

        // 커스텀 프롬프트인 경우
        const customPrompt = this.customPrompts.find(p => p.id === selectedValue);
        if (customPrompt) {
            promptEditor.value = customPrompt.content;
        } else {
            // 기본 프롬프트인 경우
            if (selectedValue && selectedValue in extensionSettings) {
                promptEditor.value = extensionSettings[selectedValue] || '';
            } else {
                promptEditor.value = '';
            }
        }
    }

    async showAddPromptDialog() {
        // 다이얼로그 컨텐츠 생성
        const wrapper = document.createElement('div');
        wrapper.classList.add('prompt-add-dialog');
        wrapper.innerHTML = `
            <div class="prompt-form">
                <div class="prompt-title">프롬프트 추가</div>
                <div class="prompt-form-group">
                    <input type="text" id="promptTitle" class="text_pole wide" placeholder="프롬프트 이름을 입력하세요" required>
                </div>
            </div>
        `;

        // SillyTavern의 팝업 시스템 사용
        const result = await callPopup(wrapper, 'confirm', '프롬프트 추가');

        if (!result) {
            return; // 취소 버튼 클릭 또는 팝업 닫힘
        }

        // 입력값 가져오기
        const title = document.getElementById('promptTitle').value.trim();

        if (!title) {
            toastr.warning('프롬프트 이름을 입력해주세요.');
            return;
        }

        // 새 프롬프트 추가
        const newPrompt = {
            id: Date.now().toString(),
            title: title,
            content: defaultSettings.llm_prompt_chat, // 기본 채팅 번역 프롬프트로 초기화
            isCustom: true
        };

        this.customPrompts.push(newPrompt);
        this.saveToSettings();
        this.updatePromptDropdown();
        toastr.success('새 프롬프트가 추가되었습니다.');
    }



    deleteSelectedPrompt() {
        const promptSelect = document.getElementById('prompt_select');
        const selectedPrompt = this.customPrompts.find(p => p.id === promptSelect.value);

        if (!selectedPrompt || !selectedPrompt.isCustom) {
            alert('삭제할 수 없는 프롬프트입니다.');
            return;
        }

        if (confirm('선택한 프롬프트를 삭제하시겠습니까?')) {
            const deletedPromptId = selectedPrompt.id;
            this.customPrompts = this.customPrompts.filter(p => p.id !== deletedPromptId);
            this.saveToSettings();

            // 현재 선택된 번역 프롬프트였다면 초기화
            if (extensionSettings.selected_translation_prompt_id === deletedPromptId) {
                extensionSettings.selected_translation_prompt_id = null;
                extensionSettings.selected_translation_prompt = null;
                saveSettingsDebounced();
            }

            // 프롬프트 선택 드롭다운 업데이트 (기본 프롬프트로 변경)
            this.updatePromptDropdown();

            toastr.success('프롬프트가 삭제되었습니다.');
        }
    }

    getSelectedPrompt() {
        // 저장된 선택 프롬프트 ID 확인
        const savedPromptId = extensionSettings.selected_translation_prompt_id;
        if (!savedPromptId) return null;

        // 저장된 ID로 프롬프트 찾기
        return this.customPrompts.find(p => p.id === savedPromptId);
    }

    saveToSettings() {
        extensionSettings.customPrompts = this.customPrompts;
        saveSettingsDebounced();
    }

    saveCurrentPrompt() {
        const promptSelector = document.getElementById('prompt_select');
        const promptEditor = document.getElementById('llm_prompt_editor');
        const selectedValue = promptSelector.value;
        const newContent = promptEditor.value.trim();

        if (!newContent) {
            toastr.error('프롬프트 내용을 입력해주세요.');
            return;
        }

        // 커스텀 프롬프트인 경우
        const customPrompt = this.customPrompts.find(p => p.id === selectedValue);
        if (customPrompt) {
            customPrompt.content = newContent;
            this.saveToSettings();

            // 현재 선택된 번역 프롬프트인 경우 업데이트
            if (extensionSettings.selected_translation_prompt_id === customPrompt.id) {
                extensionSettings.selected_translation_prompt = newContent;
                saveSettingsDebounced();
            }

            toastr.success(`프롬프트 "${customPrompt.title}"가 저장되었습니다.`);
        } else {
            // 기본 프롬프트인 경우
            const promptKey = selectedValue;
            if (promptKey && promptKey in extensionSettings) {
                extensionSettings[promptKey] = newContent;
                saveSettingsDebounced();
                toastr.success('프롬프트가 저장되었습니다.');
            }
        }
    }
}

// 번역문/원문 토글 슬래시 커맨드
SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'LlmToggleTranslation',
    callback: async (parsedArgs) => {
        const messageIdStr = validateAndNormalizeMessageId(parsedArgs.messageId);

        let actualMessageId = messageIdStr;
        if (messageIdStr === 'last') {
            const context = getContext();
            if (!context || !context.chat || context.chat.length === 0) {
                return '채팅 메시지가 없습니다.';
            }
            actualMessageId = context.chat.length - 1;
        }

        const messageId = parseInt(actualMessageId, 10);
        if (isNaN(messageId) || messageId < 0) {
            return `유효하지 않은 메시지 ID: "${actualMessageId}". 숫자를 입력하세요.`;
        }

        const context = getContext();
        if (!context || !context.chat) {
            return '컨텍스트 또는 채팅 데이터를 찾을 수 없습니다.';
        }
        if (messageId >= context.chat.length) {
            return `메시지 ID ${messageId}를 찾을 수 없습니다. (채팅 길이: ${context.chat.length})`;
        }

        // 번역 진행 중 확인
        if (translationInProgress[messageId]) {
            toastr.info('번역이 이미 진행 중입니다.');
            return `메시지 ID ${messageId}는 이미 번역이 진행 중입니다.`;
        }

        // 백그라운드에서 토글 실행 (UI 블로킹 방지)
        handleTranslateButtonClick(messageId).catch(error => {
            console.error('Translation toggle error:', error);
            toastr.error(`메시지 ID ${messageId} 번역/원문 전환 중 오류가 발생했습니다.`);
        });

        return `메시지 ID ${messageId} 번역/원문 전환을 시작했습니다.`;
    },
    helpString: '지정한 ID의 메시지에서 번역문과 원문을 전환합니다. 번역문이 없으면 번역을 실행하고, 번역문이 표시되어 있으면 원문을 표시하며, 원문이 표시되어 있으면 번역을 실행합니다. messageId를 생략하면 마지막 메시지를 대상으로 합니다.\n사용법: /LlmToggleTranslation [messageId=<메시지ID>]',
    namedArgumentList: [
        SlashCommandNamedArgument.fromProps({
            name: 'messageId',
            description: '번역/원문을 전환할 메시지의 ID 또는 "last" (마지막 메시지)',
            isRequired: false,
            defaultValue: '{{lastMessageId}}',
            typeList: [ARGUMENT_TYPE.STRING],
        }),
    ],
}));

// 전역 인스턴스 생성
let promptManager = null;
let presetManager = null;

// 설정을 깊은 복사(deep clone)하기 위한 헬퍼 함수
function simpleDeepClone(obj) {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }

    // Date 객체 복사
    if (obj instanceof Date) {
        return new Date(obj.getTime());
    }

    // Array 복사
    if (Array.isArray(obj)) {
        return obj.map(simpleDeepClone);
    }

    // 일반 Object 복사
    const clone = {};
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            clone[key] = simpleDeepClone(obj[key]);
        }
    }
    return clone;
}

// 프리셋 관리를 위한 클래스 정의
class PresetManager {
    constructor() {
        this.presets = [];
        this.loadFromSettings();
        this.initializeEventListeners();
    }

    loadFromSettings() {
        this.presets = extensionSettings.presets || [];
    }

    saveToSettings() {
        extensionSettings.presets = this.presets;
        saveSettingsDebounced();
    }

    initializeEventListeners() {
        // 드롭다운에서 프리셋 선택 시 바로 적용
        $(document).off('change', '#llm_preset_select').on('change', '#llm_preset_select', () => {
            const selectedId = $('#llm_preset_select').val();
            if (selectedId) {
                this.applyPreset(selectedId);
            }
        });

        $(document).off('click', '#llm_preset_save').on('click', '#llm_preset_save', () => {
            this.saveCurrentPreset();
        });

        // 업데이트 버튼: 선택된 프리셋을 현재 설정으로 덮어쓰기
        $(document).off('click', '#llm_preset_update').on('click', '#llm_preset_update', () => {
            this.updateSelectedPreset();
        });

        $(document).off('click', '#llm_preset_delete').on('click', '#llm_preset_delete', () => {
            this.deleteSelectedPreset();
        });

        $(document).off('click', '#llm_preset_export').on('click', '#llm_preset_export', () => {
            this.exportToJson();
        });

        $(document).off('change', '#llm_preset_import_file').on('change', '#llm_preset_import_file', (e) => {
            const file = e.target.files[0];
            if (file) {
                this.importFromJson(file);
                e.target.value = ''; // 같은 파일 다시 선택 가능하도록 초기화
            }
        });
    }

    updatePresetDropdown() {
        const select = $('#llm_preset_select');
        if (!select.length) return;

        select.html('<option value="">-- 프리셋 선택 --</option>');

        this.presets.forEach(preset => {
            const option = $('<option></option>')
                .val(preset.id)
                .text(preset.name);
            select.append(option);
        });
    }

    async saveCurrentPreset() {
		// --- [디버깅 로그 시작] ---
        console.group('🛑 [LLM Translator] 프리셋 저장/갱신 데이터 검증');
        
        // 1. extensionSettings 상태 확인
        const extPrompts = extensionSettings.customPrompts || [];
        console.log('1. extensionSettings.customPrompts (설정 변수):');
        console.log('   - 참조(Reference):', extPrompts);
        console.log('   - 개수:', extPrompts.length);
        if (extPrompts.length > 0) {
            console.log('   - 마지막 아이템:', extPrompts[extPrompts.length - 1].title);
        }

        // 2. promptManager 상태 확인
        const pmPrompts = (typeof promptManager !== 'undefined' && promptManager) ? promptManager.customPrompts : 'promptManager 없음';
        console.log('2. promptManager.customPrompts (매니저 원본):');
        console.log('   - 참조(Reference):', pmPrompts);
        console.log('   - 개수:', Array.isArray(pmPrompts) ? pmPrompts.length : 'N/A');
        if (Array.isArray(pmPrompts) && pmPrompts.length > 0) {
            console.log('   - 마지막 아이템:', pmPrompts[pmPrompts.length - 1].title);
        }

        // 3. 비교 분석
        if (Array.isArray(pmPrompts)) {
            const isRefSame = extPrompts === pmPrompts;
            const isContentSame = JSON.stringify(extPrompts) === JSON.stringify(pmPrompts);
            
            console.log(`3. 진단 결과:`);
            console.log(`   - 메모리 주소 일치 여부 (===): ${isRefSame ? '✅ 일치 (같은 객체)' : '❌ 불일치 (다른 객체)'}`);
            console.log(`   - 데이터 내용 일치 여부: ${isContentSame ? '✅ 일치' : '❌ 불일치 (데이터가 다름!)'}`);

            if (!isRefSame && !isContentSame) {
                console.error('🚨 [치명적] extensionSettings가 promptManager의 최신 데이터를 반영하지 못하고 있습니다!');
                console.error('   -> 지금 저장하면 extensionSettings의 구버전 데이터가 저장됩니다.');
            } else if (!isRefSame && isContentSame) {
                console.warn('⚠️ [주의] 데이터 내용은 같지만 참조가 끊어져 있습니다. 추후 동기화 문제가 발생할 수 있습니다.');
            }
        }
        console.groupEnd();
        // --- [디버깅 로그 끝] ---
		
        let presetName = await callGenericPopup(
            '저장할 프리셋의 이름을 입력하세요:',
            POPUP_TYPE.INPUT,
            '',
            { wide: false, large: false }
        );

        if (!presetName || presetName.trim() === '') {
            toastr.info('프리셋 저장이 취소되었습니다.');
            return;
        }

        presetName = presetName.trim();

    
    const settingsSnapshot = simpleDeepClone(extensionSettings);
    
		// 저장할 데이터에서 'presets' 배열을 삭제 (재귀방지)
		if (settingsSnapshot.presets) {
			delete settingsSnapshot.presets;
		}

		if (settingsSnapshot.customPrompts) {
			delete settingsSnapshot.customPrompts;
		}

		const newPreset = {
			id: `preset_${Date.now()}`,
			name: presetName,
			version: 2, // V2 버전 태그
			settings: settingsSnapshot, // presets가 없는 깔끔한 설정
			customPrompts: extensionSettings.customPrompts || [] // 프롬프트는 따로 저장
		};

		// 내 목록에 추가하고 저장
        this.presets.push(newPreset);
        this.saveToSettings();
        this.updatePresetDropdown();

        $('#llm_preset_select').val(newPreset.id);
        toastr.success(`프리셋 "${presetName}"이(가) 저장되었습니다.`);
    }

    // 드롭다운 선택 시 바로 적용 (확인 없이)
    applyPreset(selectedId) {
        const preset = this.presets.find(p => p.id === selectedId);
        if (!preset) {
            toastr.error('선택한 프리셋을 찾을 수 없습니다.');
            return;
        }

        // 1. 프리셋에서 데이터 추출
        const loadedSettings = simpleDeepClone(preset.settings);
        const loadedCustomPrompts = simpleDeepClone(preset.customPrompts || []);

        // 2. 현재 내 프리셋 목록 백업 (설정 초기화 시 날아가지 않도록)
        const myCurrentPresets = this.presets; 

        // 3. 기존 설정 싹 지우기 (여기서 customPrompts도 같이 지워짐)
        Object.keys(extensionSettings).forEach(key => {
            delete extensionSettings[key];
        });

        // 4. 설정 덮어쓰기 (이 시점에는 loadedSettings 안에 customPrompts가 없음)
        Object.assign(extensionSettings, loadedSettings);

        // 5. [중요 수정] 백업해둔 데이터 복구 (순서 중요: Object.assign 이후에 실행)
        extensionSettings.presets = myCurrentPresets;
        extensionSettings.customPrompts = loadedCustomPrompts;

        // 6. 클래스 변수 동기화 및 매니저 리로드
        this.presets = myCurrentPresets; 
        
        if (promptManager) {
            promptManager.loadFromSettings(); 
        }

        // 7. UI 및 설정 저장
        loadSettings();

        if (promptManager && typeof promptManager.loadPromptToEditor === 'function') {
            promptManager.loadPromptToEditor();
        }

        this.updatePresetDropdown();
        $('#llm_preset_select').val(selectedId);

        saveSettingsDebounced();
        //toastr.success(`프리셋 "${preset.name}"을(를) 적용했습니다.`);
    }

    // 선택된 프리셋을 현재 설정으로 업데이트 (확인창 있음)
    async updateSelectedPreset() {
		
		// --- [디버깅 로그 시작] ---
        console.group('🛑 [LLM Translator] 프리셋 저장/갱신 데이터 검증');
        
        // 1. extensionSettings 상태 확인
        const extPrompts = extensionSettings.customPrompts || [];
        console.log('1. extensionSettings.customPrompts (설정 변수):');
        console.log('   - 참조(Reference):', extPrompts);
        console.log('   - 개수:', extPrompts.length);
        if (extPrompts.length > 0) {
            console.log('   - 마지막 아이템:', extPrompts[extPrompts.length - 1].title);
        }

        // 2. promptManager 상태 확인
        const pmPrompts = (typeof promptManager !== 'undefined' && promptManager) ? promptManager.customPrompts : 'promptManager 없음';
        console.log('2. promptManager.customPrompts (매니저 원본):');
        console.log('   - 참조(Reference):', pmPrompts);
        console.log('   - 개수:', Array.isArray(pmPrompts) ? pmPrompts.length : 'N/A');
        if (Array.isArray(pmPrompts) && pmPrompts.length > 0) {
            console.log('   - 마지막 아이템:', pmPrompts[pmPrompts.length - 1].title);
        }

        // 3. 비교 분석
        if (Array.isArray(pmPrompts)) {
            const isRefSame = extPrompts === pmPrompts;
            const isContentSame = JSON.stringify(extPrompts) === JSON.stringify(pmPrompts);
            
            console.log(`3. 진단 결과:`);
            console.log(`   - 메모리 주소 일치 여부 (===): ${isRefSame ? '✅ 일치 (같은 객체)' : '❌ 불일치 (다른 객체)'}`);
            console.log(`   - 데이터 내용 일치 여부: ${isContentSame ? '✅ 일치' : '❌ 불일치 (데이터가 다름!)'}`);

            if (!isRefSame && !isContentSame) {
                console.error('🚨 [치명적] extensionSettings가 promptManager의 최신 데이터를 반영하지 못하고 있습니다!');
                console.error('   -> 지금 저장하면 extensionSettings의 구버전 데이터가 저장됩니다.');
            } else if (!isRefSame && isContentSame) {
                console.warn('⚠️ [주의] 데이터 내용은 같지만 참조가 끊어져 있습니다. 추후 동기화 문제가 발생할 수 있습니다.');
            }
        }
        console.groupEnd();
        // --- [디버깅 로그 끝] ---
		
		
        const selectedId = $('#llm_preset_select').val();
        if (!selectedId) {
            toastr.warning('업데이트할 프리셋을 선택하세요.');
            return;
        }

        const preset = this.presets.find(p => p.id === selectedId);
        if (!preset) {
            toastr.error('선택한 프리셋을 찾을 수 없습니다.');
            return;
        }

        const confirm = await callGenericPopup(
            `"${preset.name}" 프리셋을 현재 설정으로 업데이트하시겠습니까?\n(기존 프리셋 내용이 덮어쓰기됩니다.)`,
            POPUP_TYPE.CONFIRM
        );

        if (!confirm) {
            toastr.info('프리셋 업데이트가 취소되었습니다.');
            return;
        }

        // 현재 설정으로 프리셋 업데이트
        const settingsSnapshot = simpleDeepClone(extensionSettings);
        
        if (settingsSnapshot.presets) {
            delete settingsSnapshot.presets;
        }
        if (settingsSnapshot.customPrompts) {
            delete settingsSnapshot.customPrompts;
        }

        // 현재 설정으로 프리셋 업데이트 (버전도 최신으로 갱신 권장)
        preset.version = 2; 
        preset.settings = settingsSnapshot;
        preset.customPrompts = simpleDeepClone(extensionSettings.customPrompts || []);

        this.saveToSettings();
        toastr.success(`프리셋 "${preset.name}"을(를) 업데이트했습니다.`);
    }

    async deleteSelectedPreset() {
        const selectedId = $('#llm_preset_select').val();
        if (!selectedId) {
            toastr.warning('삭제할 프리셋을 선택하세요.');
            return;
        }

        const preset = this.presets.find(p => p.id === selectedId);
        if (!preset) {
            toastr.error('선택한 프리셋을 찾을 수 없습니다.');
            return;
        }

        const confirm = await callGenericPopup(
            `"${preset.name}" 프리셋을 삭제하시겠습니까?`,
            POPUP_TYPE.CONFIRM
        );

        if (!confirm) {
            toastr.info('프리셋 삭제가 취소되었습니다.');
            return;
        }

        this.presets = this.presets.filter(p => p.id !== selectedId);
        this.saveToSettings();
        this.updatePresetDropdown();

        toastr.success(`프리셋 "${preset.name}"이(가) 삭제되었습니다.`);
    }

    exportToJson() {
        const exportData = {
            version: 1,
            exportDate: new Date().toISOString(),
            customPrompts: extensionSettings.customPrompts || [],
            presets: this.presets
        };

        const jsonStr = JSON.stringify(exportData, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `llm-translator-backup-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        toastr.success('프롬프트 및 프리셋을 JSON으로 내보냈습니다.');
    }

    async importFromJson(file) {
        try {
            const text = await file.text();
            const data = JSON.parse(text);

            // 버전 및 데이터 유효성 검사
            if (!data.customPrompts && !data.presets) {
                toastr.error('유효하지 않은 JSON 파일입니다.');
                return;
            }

            const confirm = await callGenericPopup(
                `JSON 파일을 가져오시겠습니까?\n\n` +
                `• 커스텀 프롬프트: ${data.customPrompts?.length || 0}개\n` +
                `• 프리셋: ${data.presets?.length || 0}개\n\n` +
                `(기존 데이터는 덮어쓰기됩니다.)`,
                POPUP_TYPE.CONFIRM
            );

            if (!confirm) {
                toastr.info('가져오기가 취소되었습니다.');
                return;
            }

            // 커스텀 프롬프트 복원
            if (data.customPrompts) {
                extensionSettings.customPrompts = data.customPrompts;
                if (promptManager) {
                    promptManager.loadFromSettings();
                }
            }

            // 프리셋 복원
            if (data.presets) {
                this.presets = data.presets;
                extensionSettings.presets = this.presets;
                this.updatePresetDropdown();
            }

            saveSettingsDebounced();
            toastr.success('프롬프트 및 프리셋을 가져왔습니다.');

        } catch (error) {
            console.error('Import error:', error);
            toastr.error('JSON 파일을 읽는 중 오류가 발생했습니다.');
        }
    }
}

