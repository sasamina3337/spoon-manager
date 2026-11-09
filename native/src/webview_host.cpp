#include "spoon/webview_host.hpp"
#include "spoon/application.hpp"
#include "spoon/storage.hpp"
#include "spoon/web_bridge.hpp"
#include "spoon/http.hpp"
#include <windows.h>
#include <commdlg.h>
#include <shellapi.h>
#include <shlwapi.h>
#include <wrl.h>
#include <WebView2.h>
#include <atomic>
#include <condition_variable>
#include <deque>
#include <functional>
#include <fstream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>

namespace spoon {
namespace {
using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;
constexpr wchar_t kPage[] = L"https://spoon-manager.example/popup/popup.html";
constexpr wchar_t kOrigin[] = L"https://spoon-manager.example/";
constexpr UINT kReplies = WM_APP + 1;
constexpr UINT kSmokeStart = WM_APP + 2;
constexpr UINT kIncoming = WM_APP + 3;
constexpr UINT kFailure = WM_APP + 4;
constexpr UINT_PTR kTimeout = 1;
constexpr UINT_PTR kRuntimePulse = 2;

bool trusted_page(const wchar_t* source) {
    if (!source) return false;
    std::wstring url(source);
    url.erase(url.find(L'#') == std::wstring::npos ? url.size() : url.find(L'#'));
    return url == kPage;
}

std::wstring wide(const std::string& input) {
    if (input.empty()) return {};
    const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input.data(),
        static_cast<int>(input.size()), nullptr, 0);
    if (!size) throw std::runtime_error("UTF-8の形式が不正です。");
    std::wstring result(size, L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input.data(),
        static_cast<int>(input.size()), result.data(), size);
    return result;
}

std::string utf8(const wchar_t* input) {
    if (!input || !*input) return {};
    const int size = WideCharToMultiByte(CP_UTF8, 0, input, -1, nullptr, 0, nullptr, nullptr);
    std::string result(size, '\0');
    WideCharToMultiByte(CP_UTF8, 0, input, -1, result.data(), size, nullptr, nullptr);
    result.pop_back();
    return result;
}

void check(HRESULT result, const char* message) {
    if (FAILED(result)) throw std::runtime_error(message);
}

struct Task {
    Json id;
    std::string operation;
    Json input;
    std::filesystem::path export_path;
    std::stop_token voice_cancel;
};

class Host {
    std::uint64_t authorization_completed_ = 0;
public:
    explicit Host(const DesktopOptions& options)
        : options_(options), application_(options.data_directory), bridge_(application_) {
        startup_phase("application");
        if (options_.demo || options_.smoke) application_.import_demo_events();
        worker_ = std::jthread([this](std::stop_token stop) { work(stop); });
    }

    ~Host() {
        lifetime_.reset(); // Pending COM completions must not dereference this.
        closing_ = true;
        voice_cancel_.request_stop();
        worker_.request_stop();
        tasks_ready_.notify_all();
        application_.stop_audio();
        application_.stop_receiving();
        if (worker_.joinable()) worker_.join();
        if (controller_) controller_->Close();
        view_.Reset();
        controller_.Reset();
        environment_.Reset();
        if (window_ && IsWindow(window_)) DestroyWindow(window_);
    }

    int run() {
        const auto instance = GetModuleHandleW(nullptr);
        WNDCLASSW wc{};
        wc.lpfnWndProc = window_proc;
        wc.hInstance = instance;
        wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
        wc.hIcon = LoadIconW(instance, L"IDI_APP_ICON");
        wc.hbrBackground = static_cast<HBRUSH>(GetStockObject(WHITE_BRUSH));
        wc.lpszClassName = L"SpoonManagerWebView2";
        RegisterClassW(&wc);
        window_ = CreateWindowExW(0, wc.lpszClassName, L"Spoon Manager",
            WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, 1220, 900,
            nullptr, nullptr, instance, this);
        if (!window_) throw std::runtime_error("メイン画面を作成できません。");
        SendMessageW(window_, WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(wc.hIcon));
        const auto small_icon = LoadImageW(instance, L"IDI_APP_ICON", IMAGE_ICON,
            GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), LR_SHARED);
        SendMessageW(window_, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(small_icon));
        startup_phase("window");
        if (!options_.smoke) ShowWindow(window_, SW_SHOW);
        SetTimer(window_, kTimeout, options_.smoke ? 60000 : 30000, nullptr);
        initialize();
        MSG message{};
        while (GetMessageW(&message, nullptr, 0, 0) > 0) {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        return exit_code_;
    }

private:
    DesktopOptions options_;
    Application application_;
    WebBridge bridge_;
    HWND window_ = nullptr;
    ComPtr<ICoreWebView2Environment> environment_;
    ComPtr<ICoreWebView2Controller> controller_;
    ComPtr<ICoreWebView2> view_;
    std::jthread worker_;
    std::mutex tasks_mutex_;
    std::condition_variable_any tasks_ready_;
    std::deque<Task> tasks_;
    std::mutex replies_mutex_;
    std::deque<Json> replies_;
    std::deque<Json> incoming_;
    std::shared_ptr<int> lifetime_ = std::make_shared<int>(0);
    std::stop_source voice_cancel_;
    std::string failure_;
    std::atomic<bool> closing_{false};
    bool ready_ = false;
    double startup_ms_ = 0;
    Json startup_phases_ = Json::object();
    int exit_code_ = 1;

    void startup_phase(const char* phase) {
        if (options_.smoke) startup_phases_[phase] = std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - options_.started).count();
    }

    static LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM w, LPARAM l) {
        auto* host = reinterpret_cast<Host*>(GetWindowLongPtrW(window, GWLP_USERDATA));
        if (message == WM_NCCREATE) {
            host = static_cast<Host*>(reinterpret_cast<CREATESTRUCTW*>(l)->lpCreateParams);
            host->window_ = window;
            SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(host));
        }
        if (!host) return DefWindowProcW(window, message, w, l);
        try { return host->handle(message, w, l); }
        catch (const std::exception& error) { host->fail(error.what()); return 0; }
    }

    LRESULT handle(UINT message, WPARAM w, LPARAM l) {
        switch (message) {
        case WM_SIZE:
            resize();
            return 0;
        case WM_GETMINMAXINFO: {
            auto* info = reinterpret_cast<MINMAXINFO*>(l);
            const UINT dpi = GetDpiForWindow(window_);
            info->ptMinTrackSize = {MulDiv(760, dpi, 96), MulDiv(600, dpi, 96)};
            return 0;
        }
        case WM_DPICHANGED: {
            const auto* rect = reinterpret_cast<const RECT*>(l);
            SetWindowPos(window_, nullptr, rect->left, rect->top,
                rect->right - rect->left, rect->bottom - rect->top, SWP_NOZORDER | SWP_NOACTIVATE);
            resize();
            return 0;
        }
        case kReplies:
            flush_replies();
            return 0;
        case kIncoming:
            if (!incoming_.empty() && !closing_) {
                auto request = std::move(incoming_.front());
                incoming_.pop_front();
                receive(request);
            }
            return 0;
        case kFailure:
            if (closing_) return 0;
            exit_code_ = 1;
            if (options_.smoke) {
                write_json_atomic(options_.data_directory / L"smoke-result.json",
                    {{"ok", false}, {"phase", ready_ ? "ui-smoke" : "startup"},
                     {"error", failure_}, {"networkActions", false}, {"host", "C++/WebView2"}});
            } else MessageBoxW(window_, wide(failure_).c_str(), L"Spoon Manager", MB_OK | MB_ICONERROR);
            SendMessageW(window_, WM_CLOSE, 0, 0);
            return 0;
        case kSmokeStart:
            check(view_->ExecuteScript(
                LR"JS((async()=>{try{const result=await globalThis.spoonNativeSmoke();await spoonNative.call('smoke-report',result);}catch(error){await spoonNative.call('smoke-report',{ok:false,error:String(error),stack:error?.stack});}})())JS",
                nullptr), "UIテストを起動できません。");
            return 0;
        case WM_TIMER:
            if (w == kTimeout) fail("画面の初期化またはUIテストがタイムアウトしました。");
            if (w == kRuntimePulse && ready_ && !closing_ && view_)
                view_->ExecuteScript(L"window.spoonNativePulse?.()", nullptr);
            return 0;
        case WM_CLOSE:
            closing_ = true;
            voice_cancel_.request_stop();
            application_.stop_audio();
            if (controller_) controller_->Close();
            DestroyWindow(window_);
            return 0;
        case WM_DESTROY:
            closing_ = true;
            PostQuitMessage(0);
            return 0;
        }
        return DefWindowProcW(window_, message, w, l);
    }

    void resize() {
        if (controller_ && window_) {
            RECT bounds{};
            GetClientRect(window_, &bounds);
            controller_->put_Bounds(bounds);
        }
    }

    void fail(const std::string& error) {
        if (closing_ || !failure_.empty()) return;
        failure_ = error;
        // Never run a modal loop inside a WebView2 COM callback.
        PostMessageW(window_, kFailure, 0, 0);
    }

    void initialize() {
        wchar_t executable[32768]{};
        if (!GetModuleFileNameW(nullptr, executable, static_cast<DWORD>(std::size(executable))))
            throw std::runtime_error("実行ファイルの場所を確認できません。");
        const auto ui = std::filesystem::path(executable).parent_path() / L"ui";
        if (!std::filesystem::exists(ui / L"popup" / L"popup.html"))
            throw std::runtime_error("画面ファイルが見つかりません。uiフォルダーを含めて再インストールしてください。");
        LPWSTR runtime = nullptr;
        const HRESULT available = GetAvailableCoreWebView2BrowserVersionString(nullptr, &runtime);
        CoTaskMemFree(runtime);
        if (FAILED(available))
            throw std::runtime_error("Microsoft Edge WebView2 Runtimeが必要です。https://go.microsoft.com/fwlink/p/?LinkId=2124703 からEvergreen Runtimeをインストールしてください。");
        startup_phase("runtime");
        const auto profile = options_.data_directory / L"webview2";
        check(CreateCoreWebView2EnvironmentWithOptions(nullptr, profile.c_str(), nullptr,
            Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
                [this, ui, alive = std::weak_ptr<int>(lifetime_)](HRESULT result, ICoreWebView2Environment* environment) -> HRESULT {
                    if (alive.expired()) return S_OK;
                    if (closing_) return S_OK;
                    try {
                        check(result, "WebView2環境を作成できません。");
                        startup_phase("environment");
                        environment_ = environment;
                        check(environment_->CreateCoreWebView2Controller(window_,
                            Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                                [this, ui, alive](HRESULT status, ICoreWebView2Controller* controller) -> HRESULT {
                                    if (alive.expired()) return S_OK;
                                    if (closing_) return S_OK;
                                    try {
                                        check(status, "WebView2画面を作成できません。");
                                        startup_phase("controller");
                                        controller_ = controller;
                                        check(controller_->get_CoreWebView2(&view_), "WebView2に接続できません。");
                                        configure_view(ui);
                                    } catch (const std::exception& error) { fail(error.what()); }
                                    return S_OK;
                                }).Get()), "WebView2画面の作成を開始できません。");
                    } catch (const std::exception& error) { fail(error.what()); }
                    return S_OK;
                }).Get()), "WebView2の起動に失敗しました。");
    }

    void configure_view(const std::filesystem::path& ui) {
        ComPtr<ICoreWebView2_3> view3;
        check(view_.As(&view3), "WebView2 Runtimeを更新してください。");
        check(view3->SetVirtualHostNameToFolderMapping(L"spoon-manager.example", ui.c_str(),
            COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS), "画面フォルダーを設定できません。");
        ComPtr<ICoreWebView2Settings> settings;
        check(view_->get_Settings(&settings), "画面設定を取得できません。");
        settings->put_AreHostObjectsAllowed(FALSE);
        settings->put_AreDefaultContextMenusEnabled(FALSE);
        settings->put_AreDevToolsEnabled(FALSE);
        settings->put_IsStatusBarEnabled(FALSE);
        ComPtr<ICoreWebView2Settings3> settings3;
        if (SUCCEEDED(settings.As(&settings3))) settings3->put_AreBrowserAcceleratorKeysEnabled(FALSE);
        EventRegistrationToken token{};
        check(view_->add_NavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>(
            [](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
                LPWSTR uri = nullptr;
                args->get_Uri(&uri);
                if (!trusted_page(uri)) args->put_Cancel(TRUE);
                CoTaskMemFree(uri);
                return S_OK;
            }).Get(), &token), "画面遷移ガードを設定できません。");
        view_->add_FrameNavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>(
            [](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
                args->put_Cancel(TRUE); return S_OK;
            }).Get(), &token);
        view_->add_NewWindowRequested(Callback<ICoreWebView2NewWindowRequestedEventHandler>(
            [](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT {
                args->put_Handled(TRUE); return S_OK;
            }).Get(), &token);
        view_->add_PermissionRequested(Callback<ICoreWebView2PermissionRequestedEventHandler>(
            [](ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* args) -> HRESULT {
                args->put_State(COREWEBVIEW2_PERMISSION_STATE_DENY); return S_OK;
            }).Get(), &token);
        ComPtr<ICoreWebView2_4> view4;
        check(view_.As(&view4), "WebView2 Runtimeを更新してください。");
        view4->add_DownloadStarting(Callback<ICoreWebView2DownloadStartingEventHandler>(
            [](ICoreWebView2*, ICoreWebView2DownloadStartingEventArgs* args) -> HRESULT {
                args->put_Cancel(TRUE); return S_OK;
            }).Get(), &token);
        // All service traffic goes through the typed C++ facade, not renderer fetch.
        ComPtr<ICoreWebView2_22> view22;
        check(view_.As(&view22), "WebView2 Runtimeを更新してください（worker通信を制限できません）。");
        check(view22->AddWebResourceRequestedFilterWithRequestSourceKinds(L"*",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL, COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL),
            "通信制限を設定できません。");
        check(view_->add_WebResourceRequested(Callback<ICoreWebView2WebResourceRequestedEventHandler>(
            [this, ui, alive = std::weak_ptr<int>(lifetime_)](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
                if (alive.expired()) return S_OK;
                try {
                ComPtr<ICoreWebView2WebResourceRequest> request;
                check(args->get_Request(&request), "通信を検証できません。");
                LPWSTR uri = nullptr;
                check(request->get_Uri(&uri), "通信先を検証できません。");
                const bool local = uri && std::wstring(uri).starts_with(kOrigin);
                const bool document = trusted_page(uri);
                CoTaskMemFree(uri);
                if (document) {
                    std::ifstream file(ui / L"popup" / L"popup.html", std::ios::binary);
                    if (!file) throw std::runtime_error("画面を読み込めません。");
                    const std::string html((std::istreambuf_iterator<char>(file)), {});
                    if (html.empty() || html.size() > 2 * 1024 * 1024) throw std::runtime_error("画面ファイルのサイズが不正です。");
                    ComPtr<IStream> stream;
                    stream.Attach(SHCreateMemStream(reinterpret_cast<const BYTE*>(html.data()), static_cast<UINT>(html.size())));
                    if (!stream) throw std::runtime_error("画面の応答を作成できません。");
                    ComPtr<ICoreWebView2WebResourceResponse> response;
                    check(environment_->CreateWebResourceResponse(stream.Get(), 200, L"OK",
                        L"Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n"
                        L"Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                        L"img-src 'self' data: blob:; font-src 'self'; connect-src 'none'; worker-src 'none'; "
                        L"frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'\r\n",
                        &response), "画面のセキュリティ設定を適用できません。");
                    check(args->put_Response(response.Get()), "画面を返せません。");
                } else if (!local) {
                    ComPtr<ICoreWebView2WebResourceResponse> response;
                    check(environment_->CreateWebResourceResponse(nullptr, 403, L"Blocked by native host",
                        L"Content-Type: text/plain\r\n", &response), "通信を遮断できません。");
                    check(args->put_Response(response.Get()), "通信を遮断できません。");
                }
                } catch (const std::exception& error) { fail(error.what()); return E_FAIL; }
                return S_OK;
            }).Get(), &token), "通信制限のハンドラーを設定できません。");
        check(view_->add_WebMessageReceived(Callback<ICoreWebView2WebMessageReceivedEventHandler>(
            [this, alive = std::weak_ptr<int>(lifetime_)](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
                if (alive.expired()) return S_OK;
                if (closing_) return S_OK;
                LPWSTR source = nullptr;
                args->get_Source(&source);
                const bool trusted = trusted_page(source);
                CoTaskMemFree(source);
                if (!trusted) return S_OK;
                LPWSTR raw = nullptr;
                args->get_WebMessageAsJson(&raw);
                try {
                    if (!raw || wcslen(raw) > 16 * 1024 * 1024) throw std::runtime_error("操作データが大きすぎます。");
                    if (incoming_.size() >= 128) throw std::runtime_error("操作が多すぎます。");
                    incoming_.push_back(Json::parse(utf8(raw)));
                    PostMessageW(window_, kIncoming, 0, 0);
                } catch (const std::exception& error) {
                    if (options_.smoke) fail(error.what());
                }
                CoTaskMemFree(raw);
                return S_OK;
            }).Get(), &token), "画面との接続を設定できません。");
        view_->add_NavigationCompleted(Callback<ICoreWebView2NavigationCompletedEventHandler>(
            [this, alive = std::weak_ptr<int>(lifetime_)](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs* args) -> HRESULT {
                if (alive.expired()) return S_OK;
                BOOL success = FALSE;
                startup_phase("navigation");
                args->get_IsSuccess(&success);
                if (!success && !closing_) fail("元の画面を読み込めませんでした。");
                return S_OK;
            }).Get(), &token);
        view_->add_ProcessFailed(Callback<ICoreWebView2ProcessFailedEventHandler>(
            [this, alive = std::weak_ptr<int>(lifetime_)](ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs*) -> HRESULT {
                if (alive.expired()) return S_OK;
                if (!closing_) fail("画面プロセスが停止しました。アプリを起動し直してください。");
                return S_OK;
            }).Get(), &token);
        std::wstring injection = LR"JS((()=>{
if(window!==window.top||location.origin!=='https://spoon-manager.example'||location.pathname!=='/popup/popup.html'||location.search)return;
const pending=new Map();let next=0;
chrome.webview.addEventListener('message',({data})=>{
 if(!data||data.nativeReply!==true)return;
 const job=pending.get(data.id);if(!job)return;
 pending.delete(data.id);clearTimeout(job.timeout);
 if(data.ok)job.resolve(data.value);else{const detail=data.error;const error=new Error(typeof detail==='string'?detail:detail?.message||'処理に失敗しました。');if(detail&&typeof detail==='object'){error.status=detail.status;error.retryAfter=detail.retryAfter;}job.reject(error);}
});
Object.defineProperty(window,'spoonNative',{value:Object.freeze({
 smoke:__SMOKE__,demo:__DEMO__,pulse:true,
 call(operation,input={}){
  return new Promise((resolve,reject)=>{
   const id=++next;
   const timeout=setTimeout(()=>{pending.delete(id);reject(new Error('処理がタイムアウトしました。'));},65000);
   pending.set(id,{resolve,reject,timeout});
   chrome.webview.postMessage({id,operation,input});
  });
 }
}),writable:false,configurable:false});
})();)JS";
        injection.replace(injection.find(L"__SMOKE__"), 9, options_.smoke ? L"true" : L"false");
        injection.replace(injection.find(L"__DEMO__"), 8, options_.demo ? L"true" : L"false");
        check(view_->AddScriptToExecuteOnDocumentCreated(injection.c_str(),
            Callback<ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler>(
                [this, alive = std::weak_ptr<int>(lifetime_)](HRESULT result, LPCWSTR) -> HRESULT {
                    if (alive.expired()) return S_OK;
                    if (closing_) return S_OK;
                    if (FAILED(result)) { fail("画面との接続スクリプトを設定できません。"); return S_OK; }
                    resize();
                    controller_->put_IsVisible(TRUE);
                    if (!options_.smoke) ShowWindow(window_, SW_SHOW);
                    if (FAILED(view_->Navigate(kPage))) fail("画面の読み込みを開始できません。");
                    return S_OK;
                }).Get()), "画面との接続スクリプトを登録できません。");
    }

    void reply(Json id, bool ok, Json result, bool open_authorization = false) {
        Json response = {{"nativeReply", true}, {"id", std::move(id)}, {"ok", ok}};
        response[ok ? "value" : "error"] = std::move(result);
        if (open_authorization) response["_openAuthorization"] = true;
        {
            std::lock_guard lock(replies_mutex_);
            replies_.push_back(std::move(response));
        }
        if (!closing_) PostMessageW(window_, kReplies, 0, 0);
    }

    void flush_replies() {
        std::deque<Json> responses;
        { std::lock_guard lock(replies_mutex_); responses.swap(replies_); }
        if (closing_) return;
        for (auto& response : responses) {
            if (response.value("ok", false) && response["value"].is_object() && response["value"].contains("_native")) {
                const auto& native = response["value"]["_native"];
                const auto completed = native.value("authorizationCompleted", std::uint64_t{0});
                if (completed > authorization_completed_) {
                    authorization_completed_ = completed;
                    if (native.value("returnToApp", true) && !options_.smoke) {
                        ShowWindow(window_, SW_RESTORE);
                        if (!SetForegroundWindow(window_)) {
                            FLASHWINFO flash{sizeof(FLASHWINFO), window_, FLASHW_TRAY, 3, 0};
                            FlashWindowEx(&flash);
                        }
                    }
                }
            }
            if (response.value("_openAuthorization", false) && response.value("ok", false)) {
                const auto url = response["value"].get<std::string>();
                // Only URLs freshly produced by SpoonClient may reach the shell.
                if (url.starts_with("https://") || url.starts_with("http://127.0.0.1:")) {
                    const auto result = reinterpret_cast<INT_PTR>(
                        ShellExecuteW(window_, L"open", wide(url).c_str(), nullptr, nullptr, SW_SHOWNORMAL));
                    if (result <= 32) {
                        response["ok"] = false;
                        response["error"] = "同意画面を外部ブラウザーで開けませんでした。";
                    }
                } else {
                    response["ok"] = false;
                    response["error"] = "同意画面のURLを確認できません。";
                }
            }
            response.erase("_openAuthorization");
            LPWSTR source = nullptr;
            view_->get_Source(&source);
            const bool trusted = trusted_page(source);
            CoTaskMemFree(source);
            if (trusted) view_->PostWebMessageAsJson(wide(response.dump()).c_str());
        }
    }

    std::filesystem::path export_path(const Json& input) {
        if (!input.is_object() || input.size() != 2 || !input.contains("kind") ||
            !input.contains("sessionKey") || !input["kind"].is_string() || !input["sessionKey"].is_string())
            throw std::runtime_error("CSV出力の指定が不正です。");
        const auto kind = input["kind"].get<std::string>();
        if (kind != "participants" && kind != "users" && kind != "logs" && kind != "events" && kind != "analytics")
            throw std::runtime_error("未対応のCSV形式です。");
        if (input["sessionKey"].get_ref<const std::string&>().size() > 1024)
            throw std::runtime_error("配信の指定が長すぎます。");
        if (options_.smoke) return options_.data_directory / wide("smoke-" + kind + ".csv");
        wchar_t path[32768]{};
        const auto suggestion = wide("spoon-" + kind + ".csv");
        wcscpy_s(path, suggestion.c_str());
        OPENFILENAMEW dialog{};
        dialog.lStructSize = sizeof(dialog);
        dialog.hwndOwner = window_;
        dialog.lpstrFilter = L"CSV ファイル (*.csv)\0*.csv\0\0";
        dialog.lpstrFile = path;
        dialog.nMaxFile = static_cast<DWORD>(std::size(path));
        dialog.lpstrDefExt = L"csv";
        dialog.lpstrTitle = L"CSVを書き出す";
        dialog.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
        if (!GetSaveFileNameW(&dialog)) {
            if (CommDlgExtendedError()) throw std::runtime_error("保存先を選択できません。");
            return {};
        }
        return path;
    }

    std::filesystem::path csv_text_path(const Json& input) {
        if (!input.is_object() || input.size() != 2 || !input.contains("name") || !input.contains("content") || !input["name"].is_string() || !input["content"].is_string()) throw std::runtime_error("CSV出力の指定が不正です。");
        const auto name = input["name"].get<std::string>();
        if (name.empty() || name.size() > 200 || !name.ends_with(".csv") || name.find_first_of("/\\:*?\"<>|\r\n") != std::string::npos || input["content"].get_ref<const std::string&>().size() > 8 * 1024 * 1024) throw std::runtime_error("CSVの名前またはサイズを確認してください。");
        if (options_.smoke) return options_.data_directory / wide(name);
        wchar_t path[32768]{}; wcscpy_s(path, wide(name).c_str());
        OPENFILENAMEW dialog{}; dialog.lStructSize = sizeof(dialog); dialog.hwndOwner = window_;
        dialog.lpstrFilter = L"CSV ファイル (*.csv)\0*.csv\0\0"; dialog.lpstrFile = path;
        dialog.nMaxFile = static_cast<DWORD>(std::size(path)); dialog.lpstrDefExt = L"csv";
        dialog.lpstrTitle = L"CSVを書き出す"; dialog.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
        if (!GetSaveFileNameW(&dialog)) {if (CommDlgExtendedError()) throw std::runtime_error("保存先を選択できません。"); return {};}
        return path;
    }

    void receive(const Json& request) {
        if (!request.is_object() || request.size() != 3 || !request.contains("id") ||
            !request["id"].is_number_unsigned() || !request.contains("operation") ||
            !request["operation"].is_string() || !request.contains("input") || !request["input"].is_object())
            throw std::runtime_error("画面との接続メッセージの形式が不正です。");
        const auto id = request["id"];
        const auto operation = request["operation"].get<std::string>();
        const auto input = request["input"];
        try {
            if (operation.size() > 64) throw std::runtime_error("操作名が長すぎます。");
            if (operation == "ready") {
                if (!input.empty() || ready_) throw std::runtime_error("画面は既に初期化されています。");
                ready_ = true;
                startup_ms_ = std::chrono::duration<double, std::milli>(
                    std::chrono::steady_clock::now() - options_.started).count();
                exit_code_ = options_.smoke ? 1 : 0;
                if (!options_.smoke) {KillTimer(window_, kTimeout); SetTimer(window_, kRuntimePulse, 1000, nullptr);}
                reply(id, true, nullptr);
                if (options_.smoke) PostMessageW(window_, kSmokeStart, 0, 0);
                return;
            }
            if (operation == "smoke-report") {
                if (!options_.smoke || !ready_) throw std::runtime_error("テストモードではありません。");
                Json result = input;
                result["startupMs"] = startup_ms_;
                result["startupPhasesMs"] = startup_phases_;
                result["networkActions"] = false;
                result["host"] = "C++/WebView2";
                const auto count = result.contains("checks") && result["checks"].is_array()
                    ? static_cast<int>(result["checks"].size()) : result.value("checks", 0);
                const bool passed = result.value("ok", false) && count > 0 &&
                    result.value("passed", 0) == count;
                result["ok"] = passed;
                write_json_atomic(options_.data_directory / L"smoke-result.json", result);
                exit_code_ = passed ? 0 : 1;
                KillTimer(window_, kTimeout);
                SendMessageW(window_, WM_CLOSE, 0, 0);
                return;
            }
            if (options_.smoke && (operation == "authorization-url" ||
                operation == "start-receiving" || operation == "send-chat" || operation == "send-generated" || operation == "manager-action" || operation == "voice-catalog" || operation == "weather" || operation == "participation" || operation == "test-voice" || operation == "diagnose-speech"))
                throw std::runtime_error("UIテストでは外部通信・音声再生を実行しません。");
            if (operation == "stop-audio") {
                if (!input.empty()) throw std::runtime_error("音声停止の指定が不正です。");
                voice_cancel_.request_stop();
                voice_cancel_ = std::stop_source{};
                application_.stop_audio(); // Never wait behind a queued voice request.
                reply(id, true, nullptr);
                return;
            }
            Task task{id, operation, input, {}, voice_cancel_.get_token()};
            if (operation == "export-csv") {
                task.export_path = export_path(input);
                if (task.export_path.empty()) { reply(id, true, {{"cancelled", true}}); return; }
            }
            if (operation == "save-csv") {
                task.export_path = csv_text_path(input);
                if (task.export_path.empty()) {reply(id, true, {{"cancelled", true}}); return;}
            }
            {
                std::lock_guard lock(tasks_mutex_);
                if (tasks_.size() >= 128) throw std::runtime_error("処理が混み合っています。少し待ってください。");
                tasks_.push_back(std::move(task));
            }
            tasks_ready_.notify_one();
        } catch (const std::exception& error) { reply(id, false, error.what()); }
    }

    void work(std::stop_token stop) {
        while (!stop.stop_requested()) {
            Task task;
            {
                std::unique_lock lock(tasks_mutex_);
                if (!tasks_ready_.wait(lock, stop, [this] { return !tasks_.empty(); })) return;
                if (stop.stop_requested()) return;
                task = std::move(tasks_.front());
                tasks_.pop_front();
            }
            try {
                Json result;
                if (task.operation == "export-csv") {
                    application_.export_csv(task.export_path, task.input.at("kind").get<std::string>(),
                        task.input.at("sessionKey").get<std::string>());
                    result = {{"cancelled", false}};
                } else if (task.operation == "save-csv") {
                    write_text_atomic(task.export_path, task.input.at("content").get<std::string>()); result = {{"cancelled", false}};
                } else if (task.operation == "test-voice") {
                    if (!task.input.empty()) throw std::runtime_error("音声テストの指定が不正です。");
                    application_.test_voice(task.voice_cancel);
                    result = nullptr;
                } else if (task.operation == "diagnose-speech") {
                    if (!task.input.empty()) throw std::runtime_error("音声診断の指定が不正です。");
                    result = application_.diagnose_speech(task.voice_cancel);
                } else result = bridge_.dispatch(task.operation, task.input);
                reply(task.id, true, std::move(result), task.operation == "authorization-url");
            } catch (const HttpError& error) {reply(task.id, false, {{"message", error.what()}, {"status", error.status}, {"retryAfter", error.retry_after}});}
            catch (const std::exception& error) { reply(task.id, false, error.what()); }
        }
    }
};
}

int run_desktop(const DesktopOptions& options) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    const HRESULT result = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    check(result, "Windows UI環境を初期化できません。");
    struct Apartment { ~Apartment() { CoUninitialize(); } } apartment;
    Host host(options);
    return host.run();
}
}
