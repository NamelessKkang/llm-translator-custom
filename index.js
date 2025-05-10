import {
    eventSource,
    event_types,
    getRequestHeaders,
    reloadCurrentChat,
    saveSettingsDebounced,
    substituteParams,
    updateMessageBlock,
} from '../../../../script.js';


import { extension_settings, getContext, saveMetadataDebounced, renderExtensionTemplateAsync } from '../../../extensions.js';
import { SECRET_KEYS, secret_state } from '../../../secrets.js';
import { POPUP_TYPE, callGenericPopup } from '../../../popup.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';


const DB_NAME = 'LLMtranslatorDB';
const STORE_NAME = 'translations';
const METADATA_BACKUP_KEY = 'llmTranslationCacheBackup'; // 메타데이터 백업 키
const extensionName = "llm-translator-custom";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const DEBUG_MODE = true; // 디버그 로그 활성화 플래그

let extensionSettings = extension_settings[extensionName];
if (!extensionSettings) {
    extensionSettings = {};
    extension_settings[extensionName] = extensionSettings;
}

// 번역 진행 상태 추적
const translationInProgress = {};

// 전체 채팅 번역의 진행 상태 추적
let isChatTranslationInProgress = false;

// 전체 채팅 번역 기본값
let isTranslateChatCanceled = false;

// --- 상태 플래그 ---
let isBackupInProgress = false;
let isRestoreInProgress = false;
let isCleanupInProgress = false;



// 기본 세팅
const defaultSettings = {
    translation_display_mode: 'disabled', // <--- 이 줄 추가
    llm_provider: 'openai',
    llm_model: 'gpt-4o-mini',
    provider_model_history: {
        openai: 'gpt-4o-mini',
        claude: 'claude-3-5-sonnet-20241022',
        google: 'gemini-1.5-pro',
        cohere: 'command'
    },
    throttle_delay: '0',
    show_input_translate_button: false,
    use_reverse_proxy: false,
    reverse_proxy_url: '',
    reverse_proxy_password: '',
    llm_prompt_chat: 'Please translate the following text to korean:',
    llm_prompt_input: 'Please translate the following text to english:',
    llm_prefill_toggle: false,
    llm_prefill_content: 'Understood. Executing the translation as instructed. Here is the translation:',
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

    // 프리필 사용 여부 및 내용 로드
    $('#llm_prefill_toggle').prop('checked', extensionSettings.llm_prefill_toggle);
    $('#llm_prefill_content').val(extensionSettings.llm_prefill_content);

    // 스로틀링 딜레이 값
    $('#throttle_delay').val(extensionSettings.throttle_delay || '0');

    // 체크박스 상태 설정 및 버튼 업데이트
    $('#llm_translation_button_toggle').prop('checked', extensionSettings.show_input_translate_button);
    updateInputTranslateButton();

    // 리버스 프록시 설정 로드
    $('#llm_use_reverse_proxy').prop('checked', extensionSettings.use_reverse_proxy);
    $('#llm_reverse_proxy_url').val(extensionSettings.reverse_proxy_url);
    $('#llm_reverse_proxy_password').val(extensionSettings.reverse_proxy_password);


    const displayMode = extensionSettings.translation_display_mode || defaultSettings.translation_display_mode;
    $('#translation_display_mode').val(displayMode);

}

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
            'gemini-2.5-pro-exp-03-25',
            'gemini-2.0-flash-thinking-exp',
            'gemini-2.0-flash-exp',
            'gemini-exp-1206',
            'gemini-exp-1121',
            'gemini-1.5-pro-latest',
            'gemini-1.5-pro',
            'gemini-1.5-pro-001',
            'gemini-1.5-pro-002',
            'gemini-1.5-flash-8b-latest',
            'gemini-1.5-flash-8b',
            'gemini-1.5-flash-8b-001',
            'gemini-1.5-flash-latest',
            'gemini-1.5-flash',
            'gemini-1.5-flash-001',
            'gemini-1.5-flash-002'
        ],
        'cohere': [
            'command-r7b-12-2024',
            'command-r-plus',
            'command-r-plus-08-2024',
            'command-r',
            'command-r-08-2024',
            'c4ai-aya-expanse-8b',
            'c4ai-aya-expanse-32b'
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
    let messages = [];
    let parameters;

    // 사용자 메시지 추가
    messages.push({ role: 'user', content: fullPrompt });

    // 프리필 사용 시 메세지 포맷
    if (extensionSettings.llm_prefill_toggle) {
        const prefillContent = extensionSettings.llm_prefill_content || 'Understood. Executing the translation as instructed. Here is my response:';

        if (provider === 'google') {
            messages.push({ role: 'model', content: prefillContent });
        } else {
            messages.push({ role: 'assistant', content: prefillContent });
        }
    }

    // 기본 파라미터 설정
    parameters = {
        model: model,
        messages: messages,
        temperature: params.temperature,
        stream: false,
        chat_completion_source: provider
    };

    // 최대 출력이 0이 아닐 때만 파라미터에 포함
    if (params.max_length > 0) {
        parameters.max_tokens = params.max_length;
    }

    // 공급자별 추가 파라미터
    const providerParams = getProviderSpecificParams(provider, params);
    Object.assign(parameters, providerParams);

    // API 키 설정
    switch (provider) {
        case 'openai':
            apiKey = secret_state[SECRET_KEYS.OPENAI];
            parameters.chat_completion_source = 'openai';
            break;
        case 'claude':
            apiKey = secret_state[SECRET_KEYS.CLAUDE];
            parameters.chat_completion_source = 'claude';
            break;
        case 'google':
            apiKey = secret_state[SECRET_KEYS.MAKERSUITE];
            parameters.chat_completion_source = 'makersuite';
            break;
        case 'cohere':
            apiKey = secret_state[SECRET_KEYS.COHERE];
            parameters.chat_completion_source = 'cohere';
            break;

        default:
            throw new Error('지원되지 않는 공급자입니다.');
    }

    if (!apiKey && !extensionSettings.use_reverse_proxy) {
        throw new Error(`${provider.toUpperCase()} API 키가 설정되어 있지 않습니다.`);
    }

    // 리버스 프록시 사용 시 파라미터 추가
    if (extensionSettings.use_reverse_proxy) {
        parameters.reverse_proxy = extensionSettings.reverse_proxy_url;
        parameters.proxy_password = extensionSettings.reverse_proxy_password;
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
        console.error('Error Response:', errorText); // 오류 로깅은 유지
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

    toastr.info('LLM 번역을 시작합니다 #' + messageId);

    // 번역 중으로 설정
    translationInProgress[messageId] = true;

    try {
        if (forceTranslate || !message.extra.display_text) {
            const originalText = substituteParams(message.mes, context.name1, message.name);
			// IndexedDB에서 번역문 가져오기
            const cachedTranslation = await getTranslationFromDB(originalText);

            if(cachedTranslation) {
                // IndexedDB에 번역문이 있으면 재사용
				// ★★★★★ 가로채기: 캐시된 번역문 처리 후 적용 ★★★★★
				message.extra.display_text = processTranslationText(originalText, cachedTranslation);

                updateMessageBlock(messageId, message);
                await context.saveChat();
                toastr.info('IndexedDB에서 번역문을 가져왔습니다.');
            } else {
                // IndexedDB에 번역문이 없으면 번역 실행
                const prompt = extensionSettings.llm_prompt_chat || 'Please translate the following text to korean:';
                const translation = await llmTranslate(originalText, prompt);

				// ★★★★★ 변경점 시작 ★★★★★
				// llmTranslate가 성공적으로 결과를 반환했을 경우 (오류 없이)
				if (translation) {
					// 2. IndexedDB에 번역 데이터 먼저 저장! (DB에는 *원본* 번역 결과 저장)
					await addTranslationToDB(originalText, translation);
					// //디버그용구분-DB저장완료
					// toastr.info('IndexedDB에서 저장 성공!'); // 사용자에게 불필요한 디버그 메시지
					// ★★★★★ 가로채기: 새로 번역된 결과 처리 후 적용 ★★★★★
					// 2. 처리된 번역 결과를 메시지 객체에 적용
					message.extra.display_text = processTranslationText(originalText, translation);

					// 4. UI 업데이트
					updateMessageBlock(messageId, message);

					// 5. 채팅 저장
					await context.saveChat();

					// 성공 토스트는 여기에 두는 것이 자연스러울 수 있음
					// toastr.success('LLM 번역 완료 #' + messageId); // 필요하다면 추가
				} else {
					// llmTranslate가 결과를 반환하지 못한 예외 케이스 처리 (기존에는 오류로 처리됨)
					// 이 부분은 llmTranslate가 항상 오류를 throw한다고 가정하면 도달하지 않을 수 있음
					console.warn('LLM 번역 결과가 비어있습니다:', messageId); // 경고 로그는 유지
					toastr.warning('번역 결과를 받지 못했지만 오류는 발생하지 않았습니다.');
				}
				// ★★★★★ 변경점 끝 ★★★★★
            }
        }
    } catch (error) {
        console.error(error); // 오류 로깅은 유지
        toastr.error(`번역 실패 #${messageId}: ${error.message}`); // 오류 메시지 구체화
        // 실패 시 message.extra.display_text는 변경되지 않음
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
    const translateButton = $('#llm_translate_chat');

    if (isChatTranslationInProgress) {
        // 번역 중이면 번역 중단
        isTranslateChatCanceled = true;
        toastr.info('채팅 번역을 중단합니다.');
        return;
    }

    // 번역 진행 중으로 상태 변경
    isChatTranslationInProgress = true;
    isTranslateChatCanceled = false;

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
        '전체 채팅을 번역하시겠습니까?',
        POPUP_TYPE.CONFIRM
    );

    if (!confirm) {
        // 번역 진행 상태 해제
        isChatTranslationInProgress = false;
        return;
    }

    // 번역 버튼을 중단 버튼으로 변경
    translateButton.find('.fa-brain').removeClass('fa-brain').addClass('fa-stop-circle');
    translateButton.find('span').text('번역 중단');
    translateButton.addClass('translating');

    toastr.info('채팅 번역을 시작합니다. 잠시만 기다려주세요.');

    try {
        // 스로틀링 설정 로드
        const throttleDelay = parseInt(extensionSettings.throttle_delay) ||0;

        for (let i =0;i < chat.length;i++) {
            if (isTranslateChatCanceled) {
                toastr.info('채팅 번역이 중단되었습니다.');
                break;
            }

            await translateMessage(i);

            if (throttleDelay >0) {
                await new Promise(resolve => setTimeout(resolve, throttleDelay));
            }
        }

        if (!isTranslateChatCanceled) {
            await context.saveChat();
            toastr.success('채팅 번역이 완료되었습니다.');
        }
    } catch (error) {
        console.error(error); // 오류 로깅 유지
        toastr.error('채팅 번역에 실패하였습니다.');
    } finally {
        // 번역 진행 상태 해제
        isChatTranslationInProgress = false;
        isTranslateChatCanceled = false;

        // 번역 버튼 원래대로 복원
        translateButton.find('.fa-stop-circle').removeClass('fa-stop-circle').addClass('fa-brain');
        translateButton.find('span').text('LLM으로 전체 번역');
        translateButton.removeClass('translating');
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
        console.error(error); // 오류 로깅 유지
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
    // ★★★★★ DB 조회 끝 ★★★★★

    // 편집 모드로 전환 (기존과 동일)
    mesBlock.addClass('translation-editing');
    mesBlock.find('.mes_buttons').hide();

    // ★★★★★ 2. Textarea를 원본 번역문으로 초기화 ★★★★★
    const editTextarea = $('<textarea>')
        .addClass('edit_textarea translation_edit_textarea')
        .val(originalDbTranslation); // <-- DB에서 가져온 원본 사용!

    // 완료 및 취소 버튼 생성 (기존과 동일)
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
    cancelButton.on('click', function() {
        // ★★★★★ 3. 편집 취소: 변경 없음, 원래 상태로 복귀 ★★★★★
        // Textarea와 버튼 제거, 원래 mesText (가공된 텍스트 포함) 표시
        editTextarea.remove();
        editButtons.remove();
        mesText.show();
        mesBlock.removeClass('translation-editing');
        mesBlock.find('.mes_buttons').show();
        // 따로 가공 처리할 필요 없음. message.extra.display_text는 변경되지 않았음.
    });

    saveButton.on('click', async function() {
        // ★★★★★ 4. 편집 내용 저장 ★★★★★
        const newText = editTextarea.val(); // 사용자가 최종 입력한 (가공 전) 텍스트

        // 원본 메시지 텍스트 다시 가져오기 (DB 키로 사용)
        const originalTextForDbKey = substituteParams(message.mes, context.name1, message.name);

        // 삭제 로직 (기존과 동일)
        if (newText.trim() === "") {
            try {
                await deleteTranslationByOriginalText(originalTextForDbKey);
                message.extra.display_text = null; // 화면 표시 텍스트 삭제
                await updateMessageBlock(messageId, message);
                await context.saveChat();
                toastr.success('번역문이 삭제되었습니다.');
            } catch (e) {
                toastr.error('번역문 삭제(DB)에 실패했습니다.');
                 console.error(e); // 오류 로깅 유지
            }
        }
        // ★★★★★ 변경 여부 확인: Textarea 내용과 *원본 DB* 값 비교 ★★★★★
        else if (newText !== originalDbTranslation) {
            try {
                // 5-1. DB 업데이트: 사용자가 입력한 *가공 전* 순수 텍스트(newText) 저장
                await updateTranslationByOriginalText(originalTextForDbKey, newText);

                // ★★★★★ 변경점: 새 processTranslationText 호출 (인자 2개) ★★★★★
                // 5-2. 화면 표시용 HTML 생성: 원본 메시지(originalTextForDbKey)와
                //      사용자가 수정한 순수 텍스트(newText)를 사용
                const processedNewText = processTranslationText(originalTextForDbKey, newText);

                // 5-3. 메시지 객체 업데이트: *가공된* HTML 문자열로
                message.extra.display_text = processedNewText;

                // 5-4. UI 업데이트 및 채팅 저장
                await updateMessageBlock(messageId, message);
                await context.saveChat();

                toastr.success('번역문이 수정되었습니다.');

            } catch (e) {
                // DB 업데이트나 후속 처리 중 오류 발생 시
                toastr.error('번역문 수정 중 오류가 발생했습니다.');
                console.error('번역문 수정 오류:', e); // 오류 로깅 유지
                // 여기서 UI를 원래대로 되돌릴지 결정할 수 있지만, 일단 에러 메시지만 표시
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
        if ($('#llm_translate_input_button').length ===0) {
            // sendform.html 로드
            $.get(`${extensionFolderPath}/sendform.html`, function(data) {
                $('#rightSendForm').append(data);
                $('#llm_translate_input_button').off('click').on('click', onTranslateInputMessageClick);
            });
        }
    } else {
        $('#llm_translate_input_button').remove();
    }
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




		// ★★★ 새로운 클릭 리스너 추가 (SillyTavern 방식 적용) ★★★
		$(document).off('click', '.prompt-editor-button').on('click', '.prompt-editor-button', async function () {
			// 1. data-for 속성에서 원본 textarea ID 가져오기
			const originalTextareaId = $(this).data('for'); // 'llm_prompt_chat', 'llm_prompt_input' 등
			const originalTextarea = $(`#${originalTextareaId}`); // jQuery 객체

			// 원본 textarea를 찾았는지 확인
			if (!originalTextarea.length) {
				console.error(`[LLM Translator] Could not find original textarea with id: ${originalTextareaId}`);
				toastr.error('편집할 원본 텍스트 영역을 찾을 수 없습니다.'); // 사용자 피드백
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
				if (originalTextareaId === 'llm_prompt_chat') {
					extensionSettings.llm_prompt_chat = popupTextarea.value;
				} else if (originalTextareaId === 'llm_prompt_input') {
					extensionSettings.llm_prompt_input = popupTextarea.value;
				} else if (originalTextareaId === 'llm_prefill_content') {
					extensionSettings.llm_prefill_content = popupTextarea.value;
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
    $('#translation_display_mode').off('change').on('change', function() {
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
	$('#llm_translator_db_tool_setup_button').off('click').on('click', async function() {
		await prepareQrAndCharacterForDbManagement();
	});

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

    // 입력 번역 체크박스 이벤트 핸들러
    $('#llm_translation_button_toggle').off('change').on('change', function() {
        extensionSettings.show_input_translate_button = $(this).is(':checked');
        saveSettingsDebounced();
        updateInputTranslateButton();
    });

    // 프리필 사용 체크박스 이벤트 핸들러
    $('#llm_prefill_toggle').off('change').on('change', function() {
        extensionSettings.llm_prefill_toggle = $(this).is(':checked');
        saveSettingsDebounced();
    });

    // 프리필 내용 입력 이벤트 핸들러
    $('#llm_prefill_content').off('input').on('input', function() {
        extensionSettings.llm_prefill_content = $(this).val();
        saveSettingsDebounced();
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

    // 스로틀링 딜레이 입력 이벤트 핸들러
    $('#throttle_delay').off('input change').on('input change', function() {
        extensionSettings.throttle_delay = $(this).val();
        saveSettingsDebounced();
    });

    // 리버스 프록시 사용 체크박스 이벤트 핸들러
    $('#llm_use_reverse_proxy').off('change').on('change', function() {
        saveReverseProxySettings();
    });

    // 리버스 프록시 URL 입력 이벤트 핸들러
    $('#llm_reverse_proxy_url').off('input').on('input', function() {
        saveReverseProxySettings();
    });

    // 리버스 프록시 비밀번호 입력 이벤트 핸들러
    $('#llm_reverse_proxy_password').off('input').on('input', function() {
        saveReverseProxySettings();
    });

    // 비밀번호 보기/숨기기 기능
    $('#llm_reverse_proxy_password_show').off('click').on('click', function() {
        const passwordInput = $('#llm_reverse_proxy_password');
        const type = passwordInput.attr('type') === 'password' ? 'text' : 'password';
        passwordInput.attr('type', type);
        $(this).toggleClass('fa-eye-slash fa-eye');
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

      const request = store.add({originalText:originalText, translation:translation, provider:provider, model:model, date:date});

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
                            if(record) {
                                 // 기존에 데이터가 있으면 갱신
                                await new Promise((resolvePut)=>{
                                  const updateRequest =  store.put({...record, translation:item.translation, provider:item.provider, model:item.model, date:item.date});
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
                                  await new Promise((resolveAdd)=>{
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

               transaction.oncomplete = function() {
                db.close();
                  toastr.success('데이터를 복원했습니다.');
                  resolve();
               }

                transaction.onerror = function(event) {
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
        const updateRequest = store.put({ ...record, translation: newTranslation, provider:provider, model:model, date:date });
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
            if(record) {
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
    if (isBackupInProgress) {
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
        isBackupInProgress = true;
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
        isBackupInProgress = false;
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
    if (isRestoreInProgress) {
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
        isRestoreInProgress = true;
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

        // ** 요구사항 4: 복원 후 메타데이터 자동 삭제 안 함 **
        // 여기에 메타데이터 삭제 코드를 넣지 않습니다.
        // 사용자가 원할 때 /llmClearBackup 커맨드를 사용합니다.
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
        isRestoreInProgress = false;
        logDebug('Restore process finished.');
    }
}

/**
 * 현재 로드된 채팅의 메타데이터에서 번역 캐시 백업을 삭제합니다.
 * @returns {Promise<void>}
 */
async function clearBackupFromMetadata() {
    const DEBUG_PREFIX = `[${extensionName} - Cleanup]`;
    if (isCleanupInProgress) {
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
        isCleanupInProgress = true;
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
        isCleanupInProgress = false;
        logDebug('Cleanup process finished.');
    }
}

/**
 * 지정된 메시지 ID에 해당하는 번역 데이터를 IndexedDB에서 삭제합니다.
 * @param {string} messageIdStr - 삭제할 메시지의 ID (문자열 형태)
 * @returns {Promise<string>} 작업 결과 메시지
 */
async function deleteTranslationById(messageIdStr) {
    const DEBUG_PREFIX = `[${extensionName} - DeleteByID]`;
    logDebug(`Attempting to delete translation for message ID: ${messageIdStr}`);

    // 1. 메시지 ID 파싱 및 유효성 검사
    const messageId = parseInt(messageIdStr, 10);
    if (isNaN(messageId) || messageId < 0) {
        const errorMsg = `유효하지 않은 메시지 ID: "${messageIdStr}". 숫자를 입력하세요.`;
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
 * 번역된 텍스트를 설정에 따라 가공합니다. (Display Mode: disabled, folded, unfolded)
 * - disabled: 원본 번역 텍스트를 그대로 반환합니다.
 * - folded: Placeholder 방식으로 특수 블록을 처리하고, 라인별 <details>/<summary> HTML을 생성합니다.
 * - unfolded: Placeholder 방식으로 특수 블록을 처리하고, 라인별 번역/원문 쌍 HTML을 생성합니다.
 * 오류 발생 시 또는 Fallback 시 적절한 출력을 반환합니다.
 * @param {string} originalText - 원본 메시지 텍스트 (HTML 포함 가능)
 * @param {string} translatedText - 번역된 텍스트 (HTML 포함 가능)
 * @returns {string} 가공된 HTML 문자열 또는 원본 번역 텍스트
 */
function processTranslationText(originalText, translatedText) {
    const DEBUG_PREFIX = '[llm-translator Debug Mode]';
    const displayMode = extensionSettings.translation_display_mode || 'disabled'; // 설정값 읽기 (기본값 'disabled')

    // console.log(`${DEBUG_PREFIX} processTranslationText START (Mode: ${displayMode})`);
    // console.log(`${DEBUG_PREFIX} Input - Original:`, originalText);
    // console.log(`${DEBUG_PREFIX} Input - Translated:`, translatedText);

    // 1. 'disabled' 모드 처리 (가장 먼저 확인)
    if (displayMode === 'disabled') {
        // console.log(`${DEBUG_PREFIX} Mode is 'disabled'. Returning raw translated text.`);
        // translatedText가 null/undefined일 경우 빈 문자열 반환
        return translatedText || '';
    }

    // 2. 'folded' 또는 'unfolded' 모드를 위한 공통 처리 시작
    // translatedText가 null, undefined, 또는 빈 문자열이면 빈 문자열 반환 (disabled 모드 외)
    if (!translatedText) {
         // console.log(`${DEBUG_PREFIX} translatedText is empty or nullish (in ${displayMode} mode). Returning empty string.`);
         return '';
    }

    // console.log(`${DEBUG_PREFIX} Mode is '${displayMode}'. Starting Placeholder processing...`);

    try {
        // 3. 특수 블록 패턴 정의 및 Placeholder 준비
        const specialBlockRegexes = [
            /<think>[\s\S]*?<\/think>/gi,
            /<thinking>[\s\S]*?<\/thinking>/gi,                 // <<<--- 여기 추가: thinking 태그
            /<tableEdit>[\s\S]*?<\/tableEdit>/gi,
            /<details[^>]*>[\s\S]*?<\/details>/gi,
            /^```[^\r\n]*\r?\n[\s\S]*?\r?\n```$/gm
        ];
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
                // console.log(`${DEBUG_PREFIX} Found & Replacing: ${placeholder} ->`, match.substring(0, 50) + '...');
                placeholderIndex++;
                return placeholder;
            });
        });
        // console.log(`${DEBUG_PREFIX} Text with Placeholders:`, textWithPlaceholders);
        // console.log(`${DEBUG_PREFIX} Special Blocks Map:`, specialBlocksMap);

        // 5. 텍스트 전처리 (<br> -> \n, trim)
        let processedTextWithPlaceholders = (textWithPlaceholders || '').replace(/<br\s*\/?>/gi, '\n').trim();
        let processedTranslated = (translatedText || '').replace(/<br\s*\/?>/gi, '\n').trim();
        let proseOnlyOriginalText = processedTextWithPlaceholders.replace(placeholderRegexGlobal, '').trim();

        // console.log(`${DEBUG_PREFIX} Processed Text w/ Placeholders (for template split):`, processedTextWithPlaceholders);
        // console.log(`${DEBUG_PREFIX} Processed Translated Text (for split):`, processedTranslated);
        // console.log(`${DEBUG_PREFIX} Processed Prose Only Original (for matching split):`, proseOnlyOriginalText);

        // 6. 라인 분리 및 정리
        const templateLines = processedTextWithPlaceholders.split('\n').map(line => line.trim());
        const proseOriginalLines = proseOnlyOriginalText.split('\n').map(line => line.trim()).filter(line => line !== '');
        const translatedLines = processedTranslated.split('\n').map(line => line.trim()).filter(line => line !== '');

        // console.log(`${DEBUG_PREFIX} Template Lines:`, templateLines, `Count: ${templateLines.length}`);
        // console.log(`${DEBUG_PREFIX} Prose Original Lines:`, proseOriginalLines, `Count: ${proseOriginalLines.length}`);
        // console.log(`${DEBUG_PREFIX} Translated Lines:`, translatedLines, `Count: ${translatedLines.length}`);

        // 7. 라인 수 일치 확인 및 처리 경로 분기
        if (proseOriginalLines.length === translatedLines.length && proseOriginalLines.length > 0) {
            // 7a. 성공 경로: 라인 수 일치 (본문 라인 1개 이상)
            // console.log(`${DEBUG_PREFIX} Line counts match (${proseOriginalLines.length}). Generating ${displayMode} HTML...`);
            const resultHtmlParts = [];
            let proseLineIndex = 0;

            for (const templateLine of templateLines) {
                if (placeholderRegexSingle.test(templateLine)) {
                    // Placeholder 복원
                    resultHtmlParts.push(specialBlocksMap[templateLine]);
                    // console.log(`${DEBUG_PREFIX} Reconstructing: Placeholder ${templateLine} -> Original Block`);
                } else if (templateLine === '') {
                    // 빈 라인 유지
                    resultHtmlParts.push('');
                    // console.log(`${DEBUG_PREFIX} Reconstructing: Empty line preserved`);
                } else {
                    // 본문 라인 처리
                    if (proseLineIndex < proseOriginalLines.length) {
                        const originalProseLine = proseOriginalLines[proseLineIndex];
                        const translatedLine = translatedLines[proseLineIndex];
                        const correctedTranslatedLine = correctBackticks(translatedLine); // 번역 라인만 백틱 처리

                        let blockHTML = '';
                        if (displayMode === 'folded') {
                            // 접기 방식 HTML
                            blockHTML =
                                '<details class="llm-translator-details mode-folded">' +
                                    '<summary class="llm-translator-summary">' +
                                        '<span class="translated_text clickable-text-org">' + correctedTranslatedLine + '</span>' +
                                    '</summary>' +
                                    '<span class="original_text">' + originalProseLine + '</span>' +
                                '</details>';
                        } else { // unfolded 모드
                            // 펼침 방식 HTML
                            blockHTML =
                                '<span class="translated_text mode-unfolded">' + correctedTranslatedLine + '</span>' +
                                '<br>' +
                                '<span class="original_text mode-unfolded">' + originalProseLine + '</span>';
                        }
                        resultHtmlParts.push(blockHTML);
                        // console.log(`${DEBUG_PREFIX} Reconstructing: Prose Line ${proseLineIndex} -> ${displayMode} Block`);
                        proseLineIndex++;
                    } else {
                        // console.warn(`${DEBUG_PREFIX} Mismatch warning: Skipping template line:`, templateLine); // 경고 로그는 유지할 수 있음
                    }
                }
            }
            const finalHtmlResult = resultHtmlParts.join('\n').trim();
            // console.log(`${DEBUG_PREFIX} Final Reconstructed HTML (Success - ${displayMode}):`, finalHtmlResult);
            return finalHtmlResult;

        } else {
            // 7b. Fallback 경로: 라인 수 불일치 또는 본문 라인 0개
            if (proseOriginalLines.length === 0 && translatedLines.length === 0 && templateLines.some(line => placeholderRegexSingle.test(line))) {
                // 특수 블록만 있는 경우: Placeholder만 복원 (모드 무관)
                // console.log(`${DEBUG_PREFIX} Fallback Case: Only special blocks found. Reconstructing blocks only.`);
                const resultHtmlParts = templateLines.map(line => {
                    return placeholderRegexSingle.test(line) ? specialBlocksMap[line] : line;
                });
                const finalHtmlResult = resultHtmlParts.join('\n').trim();
                // console.log(`${DEBUG_PREFIX} Final Reconstructed HTML (Special Blocks Only):`, finalHtmlResult);
                return finalHtmlResult;

            } else {
                 // 일반 Fallback: 라인 수 불일치 등
                 // console.warn(`${DEBUG_PREFIX} Line count mismatch or zero prose lines! Falling back to single block (${displayMode}).`); // 경고 로그 유지 가능
                 if (proseOriginalLines.length !== translatedLines.length) {
                    toastr.warning('번역문과 원문의 내용 단락 수가 일치하지 않아 전체를 하나로 표시합니다.');
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
    name: 'LlmTranslateID',
    callback: async () => {
        const m = prompt('번역할 메시지 ID를 입력하세요 (마지막 메시지는 \'last\' 입력).', 'last');
        let targetButton;

        if (m === 'last') {
            const l = document.querySelector('#chat .mes:last-child');
            if (l) {
                targetButton = l.querySelector('.mes_llm_translate');
                if (targetButton) {
                    targetButton.click();
                    return '마지막 메시지를 LLM으로 번역합니다.';
                } else {
                    return '마지막 메시지 LLM 번역 버튼을 찾을 수 없습니다.';
                }
            } else {
                return '채팅 메시지가 없습니다.';
            }
        } else {
            const p = document.querySelector(`#chat .mes[mesid='${m}']`);
            if (p) {
                targetButton = p.querySelector('.mes_llm_translate');
                if (targetButton) {
                    targetButton.click();
                    return `ID ${m} 메시지를 LLM으로 번역합니다.`;
                } else {
                    return '해당 메시지 LLM 번역 버튼을 찾을 수 없습니다.';
                }
            } else {
                return '해당 메시지 ID를 찾을 수 없습니다.';
            }
        }
    },
    helpString: '입력한 ID의 메시지를 LLM 번역기로 번역합니다.',
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
        const messageIdStr = parsedArgs.messageId;
        const swipeNumberStr = parsedArgs.swipeNumber; // optional이므로 undefined일 수 있음

        if (!messageIdStr) {
            const usage = '오류: messageId 인수가 필요합니다. 사용법: /llmDBDeleteTranslation messageId=<ID> [swipeNumber=<번호>]';
            logDebug(`${DEBUG_PREFIX_CMD} Missing required argument: messageId`);
            toastr.warning(usage);
            return usage; // 사용법 안내
        }

        // deleteTranslationById 함수 호출 (이 함수는 내부적으로 문자열 ID를 숫자로 변환함)
        // swipeNumberStr가 undefined여도 deleteTranslationById 함수에서 처리 가능
        return await deleteTranslationById(messageIdStr, swipeNumberStr);
    },
    /**
     * 도움말: 사용자가 /help llmDBDeleteTranslation 을 입력했을 때 표시될 설명입니다.
     * 사용법 예시를 named argument 방식으로 수정합니다.
     */
    helpString: '지정한 메시지 ID (및 선택적 스와이프 번호)의 LLM 번역 기록(DB) 및 화면 표시를 삭제합니다.\n사용법: /llmDBDeleteTranslation messageId=<메시지ID> [swipeNumber=<스와이프번호>]',
    /**
     * 이름 기반 인수 정의: namedArgumentList 사용
     */
    namedArgumentList: [
        SlashCommandNamedArgument.fromProps({
            name: 'messageId', // 인수 이름 (예: messageId=123)
            description: '삭제할 번역이 있는 메시지의 숫자 ID',
            isRequired: true, // 필수 인수
            typeList: [ARGUMENT_TYPE.INTEGER], // 예상 타입 (파서는 최선 노력, 콜백에서 재확인 필요)
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

SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'llmTranslate',
    helpString: 'LLM을 사용하여 텍스트를 번역합니다. 확장 프로그램 설정의 LLM 프롬프트 및 공급자 설정을 사용합니다.',
    unnamedArgumentList: [
        new SlashCommandArgument('번역할 텍스트', ARGUMENT_TYPE.STRING, true, false, ''),
    ],
    callback: async (args, value) => {
        const prompt = extensionSettings.llm_prompt_chat || 'Please translate the following text to the user\'s preferred language (or a sensible default if not specified):'; // 기본 프롬프트 제공
        const textToTranslate = String(value);

        if (!textToTranslate.trim()) {
            return '번역할 텍스트를 입력해주세요.'; // 빈 문자열 입력 방지
        }

        try {
            const translatedText = await llmTranslate(textToTranslate, prompt);
            return translatedText;
        } catch (error) {
            console.error('LLMTranslate Slash Command Error:', error);
            return `LLM 번역 중 오류 발생: ${error.message}`;
        }
    },
    returns: ARGUMENT_TYPE.STRING,
}));

// 참고: llmTranslate 함수는 이미 제공된 코드를 사용하며,
// 이 슬래시 커맨드와 동일한 파일 또는 접근 가능한 스코프에 있어야 합니다.
// 또한, extensionSettings, secret_state, getRequestHeaders 등도 마찬가지입니다.

logDebug('Slash Commands registered successfully.');
