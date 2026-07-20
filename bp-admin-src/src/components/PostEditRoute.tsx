import { useEffect, useState } from 'react';
import PostEditor from './PostEditor';

/**
 * /bp-admin/posts/[postId] 형태의 동적 라우트.
 * Astro가 output: 'static'이라 빌드 시점에 존재하는 모든 postId를
 * 알 수 없으므로(글은 계속 새로 생기고 지워짐), 정적 경로 생성 대신
 * 이 클라이언트 컴포넌트가 실행 시점에 URL에서 postId를 읽어
 * PostEditor에 넘기는 방식을 쓴다. pages/posts/edit.astro가 이 컴포넌트를
 * client:load로 감싸 로드한다.
 */
export default function PostEditRoute() {
  const [postId, setPostId] = useState<string | null>(null);

  useEffect(() => {
    // URL 형태: /bp-admin/posts/edit?id=xxxxx
    const params = new URLSearchParams(window.location.search);
    setPostId(params.get('id'));
  }, []);

  if (postId === null) {
    return <div style={{ height: 480 }} aria-hidden="true" />;
  }

  if (!postId) {
    return <p role="alert">잘못된 접근입니다. 글 ID가 URL에 없습니다.</p>;
  }

  return <PostEditor postId={postId} />;
}
