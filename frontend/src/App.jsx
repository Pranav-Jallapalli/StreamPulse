import { useEffect, useRef, useState } from 'react';
import { BrowserRouter, Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import './App.css';

const TOKEN_KEY = 'streampulse_token';
const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';
const api = axios.create({ baseURL: apiBase });
const chunkSize = 5 * 1024 * 1024;

function setAuthToken(token) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
    api.defaults.headers.common.Authorization = `Bearer ${token}`;
    return;
  }

  localStorage.removeItem(TOKEN_KEY);
  delete api.defaults.headers.common.Authorization;
}

async function fetchProfile() {
  const token = localStorage.getItem(TOKEN_KEY);

  if (!token) return null;

  setAuthToken(token);

  try {
    const response = await api.get('/me');
    return response.data.user;
  } catch (error) {
    if (error.response?.status === 401) {
      setAuthToken(null);
      return null;
    }

    throw error;
  }
}

function AppShell() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [sessionError, setSessionError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    fetchProfile()
      .then(setUser)
      .catch(() => setSessionError('Could not verify your session. Check that the API is running and try again.'))
      .finally(() => setAuthLoading(false));
  }, []);

  const handleLogout = () => {
    setAuthToken(null);
    setUser(null);
    navigate('/auth');
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link to="/" className="brand">
          StreamPulse
        </Link>

        <nav className="nav">
          <Link to="/">Home</Link>
          {user ? <Link to="/dashboard">Library</Link> : null}
          {!user ? <Link to="/auth">Login / Sign up</Link> : null}
        </nav>

        {user ? (
          <div className="user-panel">
            <span>{user.name}</span>
            <button type="button" className="ghost-button" onClick={handleLogout}>
              Logout
            </button>
          </div>
        ) : null}
      </header>

      <main className="page-content">
        {sessionError ? <p className="error-text session-error" role="alert">{sessionError}</p> : null}
        <Routes>
          <Route path="/" element={<HomePage user={user} />} />
          <Route
            path="/auth"
            element={<AuthPage onAuthSuccess={(profile) => {
              setUser(profile);
              setSessionError('');
            }} />}
          />
          <Route
            path="/dashboard"
            element={<DashboardPage currentUser={user} authLoading={authLoading} />}
          />
          <Route
            path="/watch/:id"
            element={<WatchPage authLoading={authLoading} authenticated={Boolean(user)} />}
          />
        </Routes>
      </main>
      <footer className="site-footer">
        <span>StreamPulse</span>
        <span>Video, delivered smoothly.</span>
      </footer>
    </div>
  );
}

function HomePage({ user }) {
  return (
    <section className="hero-section">
      <div className="hero-copy">
        <span className="eyebrow">Your video, in every resolution</span>
        <h1>Press play. We’ll find the right stream.</h1>
        <p>
          Upload once and enjoy adaptive HLS playback designed to keep videos moving
          across different screens and network speeds.
        </p>
        <div className="hero-actions">
          <Link to={user ? '/dashboard' : '/auth'} className="primary-button">
            {user ? 'Open your library' : 'Get started'}
          </Link>
          <a href="#how-it-works" className="secondary-button">
            How it works
          </a>
        </div>
      </div>

      <div className="hero-card">
        <div className="hero-art" aria-hidden="true">
          <div className="art-orbit orbit-one"></div>
          <div className="art-orbit orbit-two"></div>
          <div className="art-play">
            <span></span>
          </div>
          <span className="quality-tag quality-low">480p</span>
          <span className="quality-tag quality-mid">720p</span>
          <span className="quality-tag quality-high">1080p</span>
        </div>
        <div className="hero-card-caption">
          <div>
            <span className="live-dot"></span>
            Adaptive playback
          </div>
          <span>HLS ready</span>
        </div>
      </div>

      <div className="feature-strip" id="how-it-works">
        <article>
          <span className="feature-number">01</span>
          <h2>Upload in chunks</h2>
          <p>Large video uploads are sent piece by piece for a steadier transfer.</p>
        </article>
        <article>
          <span className="feature-number">02</span>
          <h2>Transcode in the background</h2>
          <p>FFmpeg creates 480p, 720p, and 1080p HLS renditions after upload.</p>
        </article>
        <article>
          <span className="feature-number">03</span>
          <h2>Play adaptively</h2>
          <p>The HLS player can adjust stream quality as network conditions change.</p>
        </article>
      </div>
    </section>
  );
}

function AuthPage({ onAuthSuccess }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError('');

    try {
      const endpoint = mode === 'signup' ? '/auth/signup' : '/auth/login';
      const response = await api.post(endpoint, form);
      setAuthToken(response.data.token);
      onAuthSuccess(response.data.user);
      navigate('/dashboard');
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Authentication failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="auth-section">
      <div className="auth-intro">
        <span className="eyebrow">Welcome to StreamPulse</span>
        <h1>{mode === 'signup' ? 'Make room for your next great video.' : 'Your library is one sign-in away.'}</h1>
        <p>Sign in to browse your library, upload videos, and watch your HLS streams.</p>
      </div>
      <div className="auth-card">
        <div className="tab-buttons">
          <button
            type="button"
            className={mode === 'login' ? 'active' : ''}
            onClick={() => {
              setMode('login');
              setError('');
            }}
          >
            Login
          </button>
          <button
            type="button"
            className={mode === 'signup' ? 'active' : ''}
            onClick={() => {
              setMode('signup');
              setError('');
            }}
          >
            Sign up
          </button>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          {mode === 'signup' ? (
            <label>
              Full name
              <input
                name="name"
                required
                maxLength={80}
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="Jane Doe"
              />
            </label>
          ) : null}
          <label>
            Email
            <input
              name="email"
              type="email"
              autoComplete="email"
              required
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              placeholder="you@example.com"
            />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              minLength={8}
              maxLength={128}
              required
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              placeholder="At least 8 characters"
            />
          </label>
          {error ? <p className="error-text">{error}</p> : null}
          <button type="submit" className="primary-button" disabled={loading}>
            {loading ? 'Please wait...' : mode === 'signup' ? 'Create account' : 'Login'}
          </button>
          <p className="form-note">Your account is protected with password hashing and expiring sessions.</p>
        </form>
      </div>
    </section>
  );
}

function DashboardPage({ currentUser, authLoading }) {
  const [videos, setVideos] = useState([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [videoFile, setVideoFile] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef(null);

  const refreshVideos = async () => {
    try {
      const response = await api.get('/videos');
      setVideos(response.data);
      setError('');
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Could not load videos.');
    }
  };

  useEffect(() => {
    if (!currentUser) return undefined;
    let active = true;
    const loadVideos = () => {
      api.get('/videos')
        .then((response) => {
          if (active) {
            setVideos(response.data);
            setError('');
          }
        })
        .catch((requestError) => {
          if (active) {
            setError(requestError.response?.data?.message || 'Could not load videos.');
          }
        });
    };
    const initialLoad = window.setTimeout(loadVideos, 0);
    const timer = window.setInterval(loadVideos, 5000);
    return () => {
      active = false;
      window.clearTimeout(initialLoad);
      window.clearInterval(timer);
    };
  }, [currentUser]);

  if (authLoading) {
    return <section className="empty-state"><p>Checking your session...</p></section>;
  }

  if (!currentUser) {
    return (
      <section className="empty-state">
        <h2>Log in to open your library.</h2>
        <Link to="/auth" className="primary-button">Go to login</Link>
      </section>
    );
  }

  const handleUpload = async (event) => {
    event.preventDefault();
    if (!videoFile) {
      setError('Choose a video file to upload.');
      return;
    }

    try {
      setLoading(true);
      setUploadProgress(0);
      setError('');
      const initialized = await api.post('/videos/uploads/init', {
        title,
        description,
        fileName: videoFile.name,
        fileSize: videoFile.size,
        mimeType: videoFile.type,
      });
      const { uploadId, totalChunks } = initialized.data;

      for (let index = 0; index < totalChunks; index += 1) {
        const start = index * chunkSize;
        const chunk = videoFile.slice(start, Math.min(start + chunkSize, videoFile.size));
        const body = new FormData();
        body.append('chunk', chunk, `chunk-${index}`);

        await api.put(`/videos/uploads/${uploadId}/chunks/${index}`, body, {
          onUploadProgress: (progressEvent) => {
            const sent = Math.min(progressEvent.loaded, chunk.size);
            setUploadProgress(Math.round(((start + sent) / videoFile.size) * 100));
          },
        });
      }

      await api.post(`/videos/uploads/${uploadId}/complete`);
      setTitle('');
      setDescription('');
      setVideoFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setUploadProgress(100);
      await refreshVideos();
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Upload failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleRetry = async (videoId) => {
    try {
      setError('');
      await api.post(`/videos/${videoId}/retry`);
      await refreshVideos();
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Could not retry video processing.');
    }
  };

  const readyCount = videos.filter((video) => video.status === 'ready').length;
  const processingCount = videos.filter((video) => ['uploading', 'processing', 'uploaded'].includes(video.status)).length;

  return (
    <section className="library-page">
      <div className="library-heading">
        <div>
          <span className="eyebrow">Creator space</span>
          <h1>Your library</h1>
          <p>Upload a video and we’ll prepare it for adaptive playback.</p>
        </div>
        <div className="library-stats">
          <div><strong>{videos.length}</strong><span>videos</span></div>
          <div><strong>{readyCount}</strong><span>ready</span></div>
          <div><strong>{processingCount}</strong><span>processing</span></div>
        </div>
      </div>

      <div className="dashboard-grid">
        <section className="panel upload-panel">
          <div className="panel-heading">
            <span className="panel-icon">↑</span>
            <div><h2>Upload a video</h2><p>Chunked upload · up to 2 GB</p></div>
          </div>
          <form onSubmit={handleUpload} className="upload-form">
            <label>
              Video title
              <input
                required
                maxLength={160}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Give your video a title"
              />
            </label>
            <label>
              Description <span className="label-optional">Optional</span>
              <textarea
                maxLength={2000}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What is this video about?"
              />
            </label>
            <label className="file-drop">
              <span className="upload-cloud">↥</span>
              <strong>{videoFile ? videoFile.name : 'Choose a video file'}</strong>
              <small>{videoFile ? `${(videoFile.size / (1024 * 1024)).toFixed(1)} MB` : 'MP4, MOV, WebM · max 2 GB'}</small>
              <input
                type="file"
                accept="video/*"
                required
                ref={fileInputRef}
                onChange={(event) => setVideoFile(event.target.files?.[0] || null)}
              />
            </label>
            {loading ? (
              <div className="progress-wrap">
                <div className="progress-label"><span>Uploading</span><span>{uploadProgress}%</span></div>
                <progress value={uploadProgress} max="100" />
              </div>
            ) : null}
            {error ? <p className="error-text">{error}</p> : null}
            <button type="submit" className="primary-button" disabled={loading}>
              {loading ? 'Uploading video...' : 'Upload video'}
            </button>
            <p className="form-note">Transcoding to 480p, 720p, and 1080p starts automatically after upload.</p>
          </form>
        </section>

        <section className="panel videos-panel">
          <div className="panel-heading">
            <div><h2>All videos</h2><p>Your uploads and their processing status</p></div>
            <button type="button" className="refresh-button" onClick={refreshVideos} aria-label="Refresh videos">↻</button>
          </div>
          {videos.length === 0 ? (
            <div className="library-empty">
              <span className="empty-play">▶</span>
              <h3>Your library is ready</h3>
              <p>Videos you upload will show up here.</p>
            </div>
          ) : (
            <div className="video-list">
              {videos.map((video) => (
                <VideoCard key={video.id} video={video} onRetry={handleRetry} />
              ))}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

function VideoCard({ video, onRetry }) {
  const [retrying, setRetrying] = useState(false);
  const ready = video.status === 'ready';
  const failed = video.status === 'failed';
  const retry = async () => {
    setRetrying(true);
    await onRetry(video.id);
    setRetrying(false);
  };
  const content = (
    <>
      <div className="video-thumbnail" aria-hidden="true"><span>▶</span></div>
      <div className="video-card-copy">
        <div className="video-card-heading">
          <h3>{video.title}</h3>
          <span className={`status-pill status-${video.status}`}>
            <span></span>{video.status}
          </span>
        </div>
        <p>{video.description || 'No description provided.'}</p>
        <small>
          {(video.size / (1024 * 1024)).toFixed(1)} MB · {new Date(video.created_at).toLocaleDateString()}
        </small>
        <small>
          {(video.views_count || 0).toLocaleString()} views · {(video.likes_count || 0).toLocaleString()} likes
        </small>
        {failed && video.failure_reason ? <small className="failure-note">{video.failure_reason}</small> : null}
        {failed && video.file_url === null ? (
          <button type="button" className="retry-button" disabled={retrying} onClick={retry}>
            {retrying ? 'Retrying...' : 'Retry processing'}
          </button>
        ) : null}
      </div>
    </>
  );

  return ready ? (
    <Link className="video-card" to={`/watch/${video.id}`}>{content}</Link>
  ) : (
    <article className="video-card">{content}</article>
  );
}

function WatchPage({ authLoading, authenticated }) {
  const { id } = useParams();
  const playerRef = useRef(null);
  const countedViewRef = useRef('');
  const [video, setVideo] = useState(null);
  const [likesCount, setLikesCount] = useState(0);
  const [viewsCount, setViewsCount] = useState(0);
  const [liked, setLiked] = useState(false);
  const [likeLoading, setLikeLoading] = useState(false);
  const [commentsState, setCommentsState] = useState({
    videoId: id,
    items: [],
    loading: true,
    error: '',
  });
  const comments = commentsState.videoId === id ? commentsState.items : [];
  const commentsLoading = commentsState.videoId !== id || commentsState.loading;
  const commentError = commentsState.videoId === id ? commentsState.error : '';
  const [commentText, setCommentText] = useState('');
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [fallbackNotice, setFallbackNotice] = useState(null);

  useEffect(() => {
    if (authLoading || !authenticated) return undefined;

    let active = true;
    const loadVideo = async () => {
      try {
        const response = await api.get(`/videos/${id}`);
        if (active) {
          setVideo(response.data);
          setLikesCount(response.data.likes_count);
          setViewsCount(response.data.views_count);
          setLiked(response.data.liked_by_user);
        }
      } catch (requestError) {
        if (active) {
          setError({
            id,
            message: requestError.response?.data?.message || 'Could not load the video.',
          });
        }
      }
    };
    loadVideo();
    return () => { active = false; };
  }, [id, authLoading, authenticated]);

  useEffect(() => {
    if (authLoading || !authenticated) return undefined;

    let active = true;

    api.get(`/videos/${id}/comments`)
      .then((response) => {
        if (active) {
          setCommentsState({
            videoId: id,
            items: response.data,
            loading: false,
            error: '',
          });
        }
      })
      .catch((requestError) => {
        if (active) {
          setCommentsState({
            videoId: id,
            items: [],
            loading: false,
            error: requestError.response?.data?.message || 'Could not load comments.',
          });
        }
      });

    return () => { active = false; };
  }, [id, authLoading, authenticated]);

  const handleLike = async () => {
    if (!video || likeLoading) return;

    try {
      setLikeLoading(true);
      const response = await api.post(`/videos/${id}/like`, { liked: !liked });
      setLiked(response.data.liked_by_user);
      setLikesCount(response.data.likes_count);
    } catch (requestError) {
      setError({
        id,
        message: requestError.response?.data?.message || 'Could not update your like.',
      });
    } finally {
      setLikeLoading(false);
    }
  };

  const handleFirstPlay = async () => {
    if (countedViewRef.current === id) return;
    countedViewRef.current = id;

    try {
      const response = await api.post(`/videos/${id}/view`);
      setViewsCount(response.data.views_count);
    } catch (requestError) {
      countedViewRef.current = '';
      console.error('Could not record video view:', requestError);
    }
  };

  const handleCommentSubmit = async (event) => {
    event.preventDefault();
    const body = commentText.trim();
    if (!body || commentSubmitting) return;

    try {
      setCommentSubmitting(true);
      const response = await api.post(`/videos/${id}/comments`, { body });
      setCommentsState((current) => ({
        videoId: id,
        items: [response.data, ...(current.videoId === id ? current.items : [])].slice(0, 100),
        loading: false,
        error: '',
      }));
      setCommentText('');
    } catch (requestError) {
      setCommentsState((current) => ({
        videoId: id,
        items: current.videoId === id ? current.items : [],
        loading: false,
        error: requestError.response?.data?.message || 'Could not post your comment.',
      }));
    } finally {
      setCommentSubmitting(false);
    }
  };

  useEffect(() => {
    if (
      authLoading ||
      !authenticated ||
      !video ||
      video.id !== id ||
      video.status !== 'ready' ||
      !playerRef.current
    ) return undefined;

    const token = localStorage.getItem(TOKEN_KEY);
    const apiOrigin = apiBase.replace(/\/api\/?$/, '');
    const url = `${apiOrigin}${video.file_url}`;
    let active = true;
    let fallbackStarted = false;
    let hls;

    const playSourceFile = async () => {
      if (fallbackStarted) return;
      fallbackStarted = true;
      hls?.stopLoad();
      hls?.detachMedia();

      try {
        const response = await api.get(`/videos/${video.id}/stream-ticket`);
        if (!active || !playerRef.current) return;
        setFallbackNotice({
          id,
          message: 'Adaptive HLS is unavailable in this browser, so the original video is playing instead.',
        });
        playerRef.current.src = `${apiOrigin}/api/source/${video.id}?ticket=${encodeURIComponent(response.data.ticket)}`;
        playerRef.current.load();
      } catch (requestError) {
        if (active) {
          setError({
            id,
            message: requestError.response?.data?.message || 'Could not start video playback.',
          });
        }
      }
    };

    const setupPlayer = async () => {
      try {
        const { default: Hls } = await import('hls.js/light');
        if (!active || !playerRef.current) return;

        if (Hls.isSupported()) {
          hls = new Hls({
            xhrSetup(xhr) {
              if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
            },
          });
          hls.loadSource(url);
          hls.attachMedia(playerRef.current);
          hls.on(Hls.Events.ERROR, (_, data) => {
            if (!data.fatal) return;

            if (data.details === 'bufferAddCodecError' || data.details === 'bufferAppendError') {
              console.warn('HLS codec is unsupported by this browser; using the original video.');
              playSourceFile();
              return;
            }

            console.error('Fatal HLS playback error:', {
              type: data.type,
              details: data.details,
              responseCode: data.response?.code,
            });
            setError({
              id,
              message: `Playback failed (${data.details}). Reload the video to try again.`,
            });
          });
          return;
        }

        if (playerRef.current.canPlayType('application/vnd.apple.mpegurl')) {
          const response = await api.get(`/videos/${video.id}/stream-ticket`);
          if (active && playerRef.current) {
            playerRef.current.src = `${url}?ticket=${encodeURIComponent(response.data.ticket)}`;
          }
          return;
        }

        await playSourceFile();
      } catch (requestError) {
        if (active) {
          setError({
            id,
            message: requestError.response?.data?.message || 'Could not start video playback.',
          });
        }
      }
    };

    setupPlayer();
    return () => {
      active = false;
      hls?.destroy();
    };
  }, [id, video, authLoading, authenticated]);

  if (!authLoading && !authenticated) {
    return (
      <section className="empty-state">
        <h2>Log in to watch this video.</h2>
        <Link to="/auth" className="secondary-button">Go to login</Link>
      </section>
    );
  }

  if (error?.id === id) {
    return <section className="empty-state"><h2>{error.message}</h2><Link to="/dashboard" className="secondary-button">Back to library</Link></section>;
  }

  if (authLoading || !video || video.id !== id) {
    return <section className="empty-state"><p>Loading video...</p></section>;
  }

  if (video.status !== 'ready') {
    return (
      <section className="empty-state">
        <span className={`status-pill status-${video.status}`}><span></span>{video.status}</span>
        <h2>This video is not ready to play yet.</h2>
        <Link to="/dashboard" className="secondary-button">Back to library</Link>
      </section>
    );
  }

  return (
    <section className="watch-section">
      <div className="watch-header">
        <Link to="/dashboard" className="back-link">← Back to library</Link>
        <span className="stream-badge">
          <span className="live-dot"></span>
          {fallbackNotice?.id === id ? 'Original video · native playback' : 'HLS adaptive stream'}
        </span>
      </div>
      <div className="watch-player">
        <video
          ref={playerRef}
          controls
          playsInline
          preload="metadata"
          onPlay={handleFirstPlay}
          onError={() => {
            if (fallbackNotice?.id === id) {
              setError({
                id,
                message: 'This browser cannot decode the original video format.',
              });
            }
          }}
        />
      </div>
      {fallbackNotice?.id === id ? (
        <p className="playback-notice" role="status">{fallbackNotice.message}</p>
      ) : null}
      <div className="video-meta">
        <div>
          <h1>{video.title}</h1>
          <p>{video.description || 'No description provided.'}</p>
          <div className="video-engagement">
            <span>{viewsCount.toLocaleString()} {viewsCount === 1 ? 'view' : 'views'}</span>
            <span className="engagement-divider" aria-hidden="true">·</span>
            <span>{likesCount.toLocaleString()} {likesCount === 1 ? 'like' : 'likes'}</span>
          </div>
        </div>
        <div className="video-actions">
          <button
            type="button"
            className={`like-button${liked ? ' is-liked' : ''}`}
            onClick={handleLike}
            disabled={likeLoading}
            aria-pressed={liked}
          >
            <span aria-hidden="true">{liked ? '♥' : '♡'}</span>
            {liked ? 'Liked' : 'Like'}
          </button>
          <span className="quality-badge">
            {fallbackNotice?.id === id ? 'Original video' : 'AUTO · 480p–1080p'}
          </span>
        </div>
      </div>
      <section className="comments-section" aria-labelledby="comments-heading">
        <div className="comments-heading">
          <h2 id="comments-heading">Comments</h2>
          <span>{comments.length === 100 ? 'Latest 100' : comments.length}</span>
        </div>
        <form className="comment-form" onSubmit={handleCommentSubmit}>
          <label className="visually-hidden" htmlFor="video-comment">Write a comment</label>
          <textarea
            id="video-comment"
            value={commentText}
            onChange={(event) => setCommentText(event.target.value.slice(0, 1000))}
            placeholder="Share your thoughts..."
            rows={3}
            maxLength={1000}
            required
          />
          <div className="comment-form-footer">
            <span>{commentText.length}/1000</span>
            <button
              type="submit"
              className="comment-submit"
              disabled={!commentText.trim() || commentSubmitting}
            >
              {commentSubmitting ? 'Posting...' : 'Post comment'}
            </button>
          </div>
        </form>
        {commentError ? <p className="comment-error" role="alert">{commentError}</p> : null}
        {commentsLoading ? (
          <p className="comments-state">Loading comments...</p>
        ) : comments.length ? (
          <ol className="comment-list">
            {comments.map((comment) => (
              <li className="comment-item" key={comment.id}>
                <div className="comment-avatar" aria-hidden="true">
                  {comment.author_name.charAt(0).toUpperCase()}
                </div>
                <div className="comment-content">
                  <div className="comment-byline">
                    <strong>{comment.author_name}</strong>
                    <time dateTime={`${comment.created_at.replace(' ', 'T')}Z`}>
                      {new Date(`${comment.created_at.replace(' ', 'T')}Z`).toLocaleString()}
                    </time>
                  </div>
                  <p>{comment.body}</p>
                </div>
              </li>
            ))}
          </ol>
        ) : commentError ? null : (
          <p className="comments-state">No comments yet. Start the conversation.</p>
        )}
      </section>
    </section>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  );
}

export default App;
