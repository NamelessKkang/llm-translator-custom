import {
    eventSource,
    event_types,
    getRequestHeaders,
    reloadCurrentChat,
    saveSettingsDebounced,
    substituteParams,
    updateMessageBlock,
} from '../../../../script.js';

import { extension_settings, getContext } from '../../../extensions.js';
import { SECRET_KEYS, secret_state } from '../../../secrets.js';
import { POPUP_TYPE, callGenericPopup } from '../../../popup.js';

const extensionName = "llm-translator";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

let extensionSettings = extension_settings[extensionName];
if (!extensionSettings) {
    extensionSettings = {};
    extension_settings[extensionName] = extensionSettings;
}

// 번역 진행 상태 추적
const translationInProgress = {};

// 전체 채팅 번역의 진행 상태 추적
let isChatTranslationInProgress = false;

// 기본 세팅
const defaultSettings = {
    llm_provider: 'openai',
    llm_model: 'gpt-4o-mini',
    provider_model_history: {
        openai: 'gpt-4o-mini',
        claude: 'claude-3-5-sonnet-20241022',
        google: 'gemini-1.5-pro',
        cohere: 'command'
    },
    llm_prompt_chat: 'Please translate the following text to korean:',
    llm_prompt_input: 'Please translate the following text to english:',
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
    $('#llm_prompt_chat').val(extensionSettings.llm_prompt_chat);
    $('#llm_prompt_input').val(extensionSettings.llm_prompt_input);

    // 현재 공급자의 파라미터 불러오기
    updateParameterVisibility(currentProvider);
    loadParameterValues(currentProvider);

    // 현재 공급자의 마지막 사용 모델 불러오기
    updateModelList();
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
    $(`.${provider}_params input`).each(function() {
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
    const params = {...extensionSettings.parameters[provider]};
    
    // 공통 파라미터 저장
    params.max_length = parseInt($('#max_length').val());
    params.temperature = parseFloat($('#temperature').val());
    
    // 공급자별 파라미터 저장
    $(`.${provider}_params input.neo-range-input`).each(function() {
        const paramName = $(this).attr('id').replace(`_${provider}`, '');
        params[paramName] = parseFloat($(this).val());
    });
    
    extensionSettings.parameters[provider] = params;
    saveSettingsDebounced();
}

// 공급자별 특정 파라미터 추출
function getProviderSpecificParams(provider, params) {
    switch(provider) {
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
            'gpt-4o',
            'gpt-4o-2024-11-20',
            'gpt-4o-2024-08-06',
            'gpt-4o-2024-05-13',
            'chatgpt-4o-latest',
            'gpt-4o-mini',
            'gpt-4o-mini-2024-07-18',
            'o1-preview',
            'o1-mini',
            'gpt-4-turbo',
            'gpt-4-turbo-2024-04-09',
            'gpt-4-1106-preview',
            'gpt-4',
            'gpt-4-0613',
            'gpt-4-32k',
            'gpt-4-32k-0613',
            'gpt-4-32k-0314',
            'gpt-3.5-turbo',
            'gpt-3.5-turbo-instruct'
        ],
        'claude': [
            'claude-3-5-sonnet-20241022',
            'claude-3-5-sonnet-20240620',
            'claude-3-5-haiku-20241022',
            'claude-3-opus-20240229',
            'claude-3-sonnet-20240229',
            'claude-3-haiku-20240307',
            'claude-2.1',
            'claude-2.0',
            'claude-1.3'
        ],
        'google': [
            'gemini-2.0-flash-exp',
            'gemini-exp-1206',
            'gemini-exp-1121',
            'gemini-1.5-pro',
            'gemini-1.5-pro-latest',
            'gemini-1.5-pro-002',
            'gemini-1.5-pro-001',
            'gemini-1.5-pro-exp-0827',
            'gemini-1.5-pro-exp-0801',
            'gemini-1.5-flash',
            'gemini-1.5-flash-latest',
            'gemini-1.5-flash-002',
            'gemini-1.5-flash-001',
            'gemini-1.5-flash-exp-0827',
            'gemini-1.5-flash-8b',
            'gemini-1.5-flash-8b-exp-0827',
            'gemini-1.5-flash-8b-exp-0924'
        ],
        'cohere': [
            'c4ai-aya-expanse-32b',
            'c4ai-aya-expanse-8b',
            'command-light',
            'command',
            'command-r',
            'command-r-plus',
            'command-r-08-2024',
            'command-r-plus-08-2024'
        ]
    };

    const providerModels = models[provider] || [];
    for (const model of providerModels) {
        modelSelect.append(`<option value="${model}">${model}</option>`);
    }

    // 해당 공급자의 마지막 사용 모델을 선택
    const lastUsedModel = extensionSettings.provider_model_history[provider] || providerModels[0];
    modelSelect.val(lastUsedModel);
    
    // 모델과 공급자 이력 업데이트
    extensionSettings.llm_model = lastUsedModel;
    extensionSettings.provider_model_history[provider] = lastUsedModel;
    
    saveSettingsDebounced();
}

// LLM 사용 텍스트 번역
async function llmTranslate(text, prompt) {
    const provider = extensionSettings.llm_provider;
    const model = extensionSettings.llm_model;
    const params = extensionSettings.parameters[provider];
    const fullPrompt = `${prompt}\n\n${text}`;

    let apiKey;
    let messages;
    let parameters;

    switch (provider) {
        case 'openai':
            apiKey = secret_state[SECRET_KEYS.OPENAI];
            messages = [{ role: 'user', content: fullPrompt }];
            parameters = {
                model: model,
                messages: messages,
                temperature: params.temperature,
                max_tokens: params.max_length,
                stream: false,
                chat_completion_source: 'openai',
                ...getProviderSpecificParams(provider, params)
            };
            break;

        case 'claude':
            apiKey = secret_state[SECRET_KEYS.CLAUDE];
            messages = [{ role: 'user', content: fullPrompt }];
            parameters = {
                model: model,
                messages: messages,
                temperature: params.temperature,
                max_tokens: params.max_length,
                stream: false,
                chat_completion_source: 'claude',
                ...getProviderSpecificParams(provider, params)
            };
            break;

        case 'google':
            apiKey = secret_state[SECRET_KEYS.MAKERSUITE];
            messages = [{ role: 'user', content: fullPrompt }];
            parameters = {
                model: model,
                messages: messages,
                temperature: params.temperature,
                max_tokens: params.max_length,
                stream: false,
                chat_completion_source: 'makersuite',
                ...getProviderSpecificParams(provider, params)
            };
            break;

        case 'cohere':
            apiKey = secret_state[SECRET_KEYS.COHERE];
            messages = [{ role: 'user', content: fullPrompt }];
            parameters = {
                model: model,
                messages: messages,
                temperature: params.temperature,
                max_tokens: params.max_length,
                stream: false,
                chat_completion_source: 'cohere',
                ...getProviderSpecificParams(provider, params)
            };
            break;

        default:
            throw new Error('지원되지 않습니다.');
    }

    if (!apiKey) {
        throw new Error(`${provider.toUpperCase()} API 키가 설정되어 있지 않습니다.`);
    }

    const apiUrl = '/api/backends/chat-completions/generate';
    const headers = {
        ...getRequestHeaders(),
        'Content-Type': 'application/json',
    };

    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(parameters),
    });

    if (response.ok) {
        const data = await response.json();
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
        }

        if (result) return result;
        throw new Error('번역된 결과를 가져올 수 없습니다.');
    } else {
        const errorText = await response.text();
        console.error('Error Response:', errorText);
        throw new Error(`번역 실패: ${errorText}`);
    }
}

// 개별 메세지 번역
async function translateMessage(messageId, forceTranslate = false) {
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

    // 번역 중으로 설정
    translationInProgress[messageId] = true;

    try {
        if (forceTranslate || !message.extra.display_text) {
            const originalText = substituteParams(message.mes, context.name1, message.name);
            const prompt = extensionSettings.llm_prompt_chat || 'Please translate the following text to korean:';
            const translation = await llmTranslate(originalText, prompt);
            message.extra.display_text = translation;
            updateMessageBlock(messageId, message);
            await context.saveChat();
        }
    } catch (error) {
        console.error(error);
        toastr.error('번역에 실패하였습니다.');
    } finally {
        // 번역 완료 후 플래그 해제
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

    const originalDisplayText = message.extra.display_text;

    if (textBlock.data('showing-original')) {
        message.extra.display_text = originalDisplayText;
        textBlock.data('showing-original', false);
    } else {
        const originalText = substituteParams(message.mes, context.name1, message.name);
        message.extra.display_text = originalText;
        textBlock.data('showing-original', true);
    }

    await updateMessageBlock(messageId, message);

    message.extra.display_text = originalDisplayText;
}

// 전체 채팅 번역
async function onTranslateChatClick() {
    // 번역이 이미 진행 중인지 확인
    if (isChatTranslationInProgress) {
        toastr.info('채팅 번역이 이미 진행 중입니다.');
        return;
    }

    // 번역 진행 중으로 상태 변경
    isChatTranslationInProgress = true;

    const context = getContext();
    const chat = context.chat;

    if (!chat || chat.length ===0) {
        toastr.warning('번역할 채팅이 없습니다.');

        // 번역 진행 상태 해제
        isChatTranslationInProgress = false;
        return;
    }

    // 팝업으로 확인
    const confirm = await callGenericPopup(
        '전체 채팅을 번역하시겠습니까?<br><br>' +
        '<b>※주의: 한 번 시작하면 중단할 수 없습니다.</b>',
        POPUP_TYPE.CONFIRM
    );

    if (!confirm) {
        // 번역 진행 상태 해제
        isChatTranslationInProgress = false;
        return;
    }

    toastr.info('채팅 번역을 시작합니다. 잠시만 기다려주세요.');

    try {
        for (let i =0;i < chat.length;i++) {
            await translateMessage(i);
        }

        await context.saveChat();
        toastr.success('채팅 번역이 완료되었습니다.');
    } catch (error) {
        console.error(error);
        toastr.error('채팅 번역에 실패하였습니다.');
    } finally {
        // 번역 진행 상태 해제
        isChatTranslationInProgress = false;
    }
}

// 인풋 번역
async function onTranslateInputMessageClick() {
    const textarea = document.getElementById('send_textarea');

    if (!(textarea instanceof HTMLTextAreaElement)) {
        return;
    }

    if (!textarea.value) {
        toastr.warning('먼저 메시지를 입력하세요.');
        return;
    }

    try {
        const prompt = extensionSettings.llm_prompt_input || 'Please translate the following text to english:';
        const translatedText = await llmTranslate(textarea.value, prompt);
        textarea.value = translatedText;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (error) {
        console.error(error);
        toastr.error('메시지 번역에 실패하였습니다.');
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
    if (mesBlock.find('.mes_llm_translate').length >0) {
        return;
    }

    // 아이콘 생성
    const translateButton = $('<div>')
        .addClass('mes_button mes_llm_translate fa-solid fa-brain interactable')
        .attr({
            'title': 'LLM 번역',
            'data-i18n': '[title]LLM 번역',
            'tabindex': '0'
        });

    const toggleButton = $('<div>')
        .addClass('mes_button mes_toggle_original fa-solid fa-magnifying-glass interactable')
        .attr({
            'title': '원문/번역 전환',
            'data-i18n': '[title]원문/번역 전환',
            'tabindex': '0'
        });

    const editButton = $('<div>')
        .addClass('mes_button mes_edit_translation fa-solid fa-scissors interactable')
        .attr({
            'title': '번역문 수정',
            'data-i18n': '[title]번역문 수정',
            'tabindex': '0'
        });

    extraMesButtons.prepend(editButton);
    extraMesButtons.prepend(toggleButton);
    extraMesButtons.prepend(translateButton);
};

// 기존 메시지에 아이콘 추가
function addButtonsToExistingMessages() {
    $('#chat .mes').each(function() {
        const $this = $(this);
        if (!$this.find('.mes_llm_translate').length) {
            createTranslateButtons($this);
        }
    });
}

// 번역문 수정
async function editTranslation(messageId) {
    const context = getContext();
    const message = context.chat[messageId];

    if (!message?.extra?.display_text) {
        toastr.warning('수정할 번역문이 없습니다.');
        return;
    }

    const mesBlock = $(`.mes[mesid="${messageId}"]`);

    if (mesBlock.find('.translation_edit_container').length >0) {
        return;
    }

    const mesText = mesBlock.find('.mes_text');
    const mesButtons = mesBlock.find('.mes_buttons');
    const messageActionButton = mesButtons.find('.extraMesButtonsHint');
    const extraMesButtons = mesButtons.find('.extraMesButtons');
    const editButton = mesButtons.find('.mes_edit');

    const originalButtonStates = extraMesButtons.find('> div').map(function() {
        return {
            element: $(this),
            display: $(this).css('display'),
            classes: $(this).attr('class')
        };
    }).get();

    mesBlock.addClass('editing');

    const editContainer = $('<div>')
        .addClass('translation_edit_container');

    const editTextarea = $('<textarea>')
        .addClass('translation_edit_textarea')
        .val(message.extra.display_text);

    editContainer.append(editTextarea);

    const buttonContainer = $('<div>')
        .addClass('translation_edit_button_container');

    const cancelButton = $('<div>')
        .addClass('translation_edit_action interactable fa-solid fa-times-circle')
        .attr('title', '취소');

    const doneButton = $('<div>')
        .addClass('translation_edit_action interactable fa-solid fa-check-circle')
        .attr('title', '저장');

    buttonContainer.append(cancelButton, doneButton);

    mesText.hide();
    mesText.after(editContainer);
    mesBlock.append(buttonContainer);

    const cleanup = async () => {
        editContainer.remove();
        buttonContainer.remove();
        mesText.show();

        originalButtonStates.forEach(({element, display, classes}) => {
            element.css('display', display);
            element.attr('class', classes);
        });

        mesBlock.removeClass('editing');
    };

    cancelButton.on('click', cleanup);

    doneButton.on('click', async () => {
        const newText = editTextarea.val();
        if (newText && newText !== message.extra.display_text) {
            message.extra.display_text = newText;
            await updateMessageBlock(messageId, message);
            await context.saveChat();
            toastr.success('번역문이 수정되었습니다.');
        }
        await cleanup();
    });

    const adjustTextareaHeight = () => {
        editTextarea.css('height', 'auto');
        editTextarea.css('height', (editTextarea[0].scrollHeight +2) +'px');
    };

    editTextarea.on('input', adjustTextareaHeight);
    adjustTextareaHeight();

    editTextarea.focus();
}

// 초기화 여부 체크
let isInitialized = false;

// jQuery 초기화 블록
jQuery(async () => {
    // 초기화 체크
    if (isInitialized) return;
    isInitialized = true;

    // 필요한 HTML과 CSS 로드
    const html = await $.get(`${extensionFolderPath}/index.html`);
    const buttonHtml = await $.get(`${extensionFolderPath}/buttons.html`);

    $('#translate_wand_container').append(buttonHtml);
    $('#translation_container').append(html);

    const cssLink = $('<link>', {
        rel: 'stylesheet',
        type: 'text/css',
        href: `${extensionFolderPath}/style.css`
    });
    $('head').append(cssLink);

    // html 완전 로드 후 설정 불러오기
    await new Promise(resolve => setTimeout(resolve, 100));
    
    loadSettings();
    initializeEventHandlers();
});

// 이벤트 핸들러 등록 함수
function initializeEventHandlers() {
    // 버튼 클릭 이벤트 핸들러
    $('#llm_translate_chat').off('click').on('click', onTranslateChatClick);
    $('#llm_translate_input_message').off('click').on('click', onTranslateInputMessageClick);
    $('#llm_translation_clear').off('click').on('click', onTranslationsClearClick);

    // 공급자 변경 이벤트 핸들러
    $('#llm_provider').off('change').on('change', function() {
        const provider = $(this).val();
        extensionSettings.llm_provider = provider;
        updateModelList();
        updateParameterVisibility(provider);
        loadParameterValues(provider);
        saveSettingsDebounced();
    });

    // 모델 변경 이벤트 핸들러
    $('#llm_model').off('change').on('change', function() {
        const provider = $('#llm_provider').val();
        const selectedModel = $(this).val();
        extensionSettings.llm_model = selectedModel;
        extensionSettings.provider_model_history[provider] = selectedModel;
        saveSettingsDebounced();
    });

    // 프롬프트 입력 이벤트 핸들러
    $('#llm_prompt_chat').off('input').on('input', function() {
        extensionSettings.llm_prompt_chat = $(this).val();
        saveSettingsDebounced();
    });

    $('#llm_prompt_input').off('input').on('input', function() {
        extensionSettings.llm_prompt_input = $(this).val();
        saveSettingsDebounced();
    });

    // 파라미터 입력 이벤트 핸들러
    $('.parameter-settings input').off('input change').on('input change', function() {
        const provider = $('#llm_provider').val();

        if ($(this).hasClass('neo-range-slider')) {
            const value = $(this).val();
            $(this).next('.neo-range-input').val(value);
        } else if ($(this).hasClass('neo-range-input')) {
            const value = $(this).val();
            $(this).prev('.neo-range-slider').val(value);
        }

        saveParameterValues(provider);
    });

    // 이벤트 소스에 이벤트 핸들러 등록
    eventSource.makeFirst(event_types.CHARACTER_MESSAGE_RENDERED, function({ messageId }) {
        translateMessage(messageId);
    });
    eventSource.makeFirst(event_types.USER_MESSAGE_RENDERED, function({ messageId }) {
        translateMessage(messageId);
    });
    eventSource.makeFirst(event_types.MESSAGE_SWIPED, function({ messageId }) {
        translateMessage(messageId);
    });

    // 메세지에 자동 번역버튼 추가
    if (!window.llmTranslatorObserver) {
        window.llmTranslatorObserver = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.classList?.contains('mes')) {
                        const $node = $(node);
                        if (!$node.find('.mes_llm_translate').length) {
                            createTranslateButtons($node);
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

    // 아이콘 클릭 이벤트 위임
    $(document).off('click', '.mes .mes_llm_translate').on('click', '.mes .mes_llm_translate', function() {
        const messageId = $(this).closest('.mes').attr('mesid');
        translateMessage(messageId, true);
    });

    $(document).off('click', '.mes .mes_toggle_original').on('click', '.mes .mes_toggle_original', function() {
        const messageId = $(this).closest('.mes').attr('mesid');
        toggleOriginalText(messageId);
    });

    $(document).off('click', '.mes .mes_edit_translation').on('click', '.mes .mes_edit_translation', function() {
        const messageId = $(this).closest('.mes').attr('mesid');
        editTranslation(messageId);
    });

    // 채팅 변경 시 아이콘 추가를 위해 이벤트 핸들러 등록
    eventSource.on(event_types.CHAT_CHANGED, function() {
        setTimeout(addButtonsToExistingMessages,100);
    });
}